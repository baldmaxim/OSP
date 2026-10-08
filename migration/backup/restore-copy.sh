#!/usr/bin/env bash
# Поднять проверенную копию прода во временном PostgreSQL в Docker и оставить работать —
# для проверки прав (npm run test:db). Прод не трогает.
#
#   bash migration/backup/restore-copy.sh migration/dumps/prod-<время>.dump
#
# Что делает: восстанавливает копию с правами (GRANT/REVOKE как на проде) и заглушками
# Supabase, включает права по умолчанию как в Supabase, накатывает миграции из
# migration/schema/applied-after.txt, которых в копии ещё нет (по их checks/*.sql), ANALYZE.
# Последние строки вывода: PORT=<порт> и CONTAINER=<имя>. Остановить: docker rm -f <имя>.
# В вывод — только имена и числа; данные остаются в контейнере.
set -euo pipefail

DUMP="${1:?укажите файл копии: migration/dumps/prod-<время>.dump}"
BASE="${DUMP%.dump}"
source "$(dirname "$0")/lib.sh"
ROOT="$(cd "$BACKUP_DIR/../.." && pwd)"

[ -f "$DUMP" ] || { echo "Нет файла $DUMP"; exit 1; }
[ -f "$BASE.verified" ] || { echo "Копия не проверена восстановлением — сначала verify.sh $DUMP"; exit 1; }

TMP="$(mktemp -d)"
KEEP=0
trap '[ "$KEEP" = 1 ] || pg_stop; rm -rf "$TMP"' EXIT

pg_start
RESTORE_PRIVILEGES=1 restore_dump "$DUMP" "$TMP/restore.log"
if [ "$RESTORE_ERRORS" != "0" ]; then
  echo "Копия восстановилась с ошибками ($RESTORE_ERRORS):"
  print_errors "$TMP/restore.log"
  exit 1
fi
local_psql -f "$BACKUP_DIR/supabase-defaults.sql" >/dev/null

# Миграции, применённые на проде после копии: накатываем те, чья проверка не проходит.
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  mig="$ROOT/supabase/migrations/$line"
  check="$BACKUP_DIR/checks/${line%%_*}.sql"
  [ -f "$mig" ] || { echo "Нет миграции $line"; exit 1; }
  if [ -f "$check" ]; then
    out="$(local_psql -At -f "$check")"
    if ! grep -q '^FAIL' <<<"$out"; then echo "Миграция $line: в копии уже есть"; continue; fi
  fi
  local_psql -c "SET client_min_messages = warning" -f "$mig" >/dev/null
  if [ -f "$check" ]; then
    out="$(local_psql -At -f "$check")"
    if grep -q '^FAIL' <<<"$out" || ! grep -q '^OK' <<<"$out"; then
      echo "Миграция $line: проверка после применения не прошла"; exit 1
    fi
  fi
  echo "Миграция $line: применена к копии"
done < "$ROOT/migration/schema/applied-after.txt"

local_psql -c 'ANALYZE' >/dev/null
KEEP=1
echo "PORT=$LOCAL_PORT"
echo "CONTAINER=$LOCAL_CONTAINER"
