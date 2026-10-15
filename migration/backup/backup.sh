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
#   prod-<время>.auth-users.csv     — учётные записи (почта, имя, даты), без паролей и одноразовых кодов
#   prod-<время>.auth-identities.csv — способы входа учётных записей
#   prod-<время>.covers.csv         — список обложек объектов (бакет object-photos): имя, размер, тип
#   prod-<время>.inventory.tsv      — опись: число строк каждой таблицы Supabase вне системных схем
#   prod-<время>.extras.sha256      — контрольные суммы четырёх файлов выше
# С ключом --credentials <открытый ключ переноса.pem> (свой вход нового портала, решение владельца 2026-10-15):
#   prod-<время>.auth-credentials.sealed        — отпечатки паролей (bcrypt), запечатанные ключом corp прямо из
#                                                 потока psql: открытого текста на диске нет (migration/accounts)
#   prod-<время>.auth-credentials.manifest.json — опись: число строк, sha256, отпечаток учёток (без почт)
# --accounts-only (вместе с --credentials) — только учётки и пароли, без копии данных: пересверка перед
# переключением своего входа и повторный перенос учёток.
# Выгрузки и опись — одна транзакция «только чтение» (extras.sql). В учётных записях — личные данные:
# файлы только здесь, права 600, в чат и git не попадают; значения не выводятся.
# Проверка восстановлением — verify.sh (её запускаю я). Копии старше 30 дней удаляйте.
set -euo pipefail

CRED_PUB=""
ACCOUNTS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --credentials) CRED_PUB="${2:-}"; [ -n "$CRED_PUB" ] && [ -r "$CRED_PUB" ] || { echo "--credentials: нет файла открытого ключа переноса" >&2; exit 1; }
                   CRED_PUB="$(cd "$(dirname "$CRED_PUB")" && pwd)/$(basename "$CRED_PUB")"; shift 2 ;;
    --accounts-only) ACCOUNTS_ONLY=1; shift ;;
    *) echo "Использование: bash migration/backup/backup.sh [--credentials <открытый ключ.pem> [--accounts-only]]" >&2; exit 1 ;;
  esac
done
[ "$ACCOUNTS_ONLY" = 0 ] || [ -n "$CRED_PUB" ] || { echo "--accounts-only — только вместе с --credentials" >&2; exit 1; }
[ -z "$CRED_PUB" ] || command -v node >/dev/null || { echo "Для --credentials нужен node" >&2; exit 1; }

cd "$(dirname "$0")/../.."
BACKUP_DIR="migration/backup"
OUT_DIR="${BACKUP_OUT_DIR:-migration/dumps}"
# Пути выгрузок передаются в psql без кавычек (\g :имя): каталог без пробелов.
case "$OUT_DIR" in *[[:space:]]*) echo "Каталог копий не должен содержать пробелов: $OUT_DIR" >&2; exit 1 ;; esac

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

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE="$OUT_DIR/prod-$STAMP"
DONE=0
# Если скрипт не дошёл до конца — убрать недописанные файлы этой копии (имена явно, без шаблонов).
cleanup() {
  unset PGPASSWORD
  if [ "$DONE" != 1 ]; then
    rm -f -- "$BASE.counts-before.tsv" "$BASE.counts-after.tsv" "$BASE.dump" "$BASE.dump.partial" "$BASE.dump.sha256" \
      "$BASE.auth-users.csv" "$BASE.auth-identities.csv" "$BASE.covers.csv" "$BASE.inventory.tsv" "$BASE.extras.sha256" \
      "$BASE.auth-credentials.sealed" "$BASE.auth-credentials.manifest.json"
  fi
}
trap cleanup EXIT

# Пробное подключение до создания файлов. Сообщение — только первая строка ошибки (в ней
# хост и имя пользователя, пароля там нет).
if ! CONNECT_ERR="$(psql -X -q -At -c 'select 1' 2>&1 >/dev/null)"; then
  echo "Не удалось подключиться к базе: $(printf '%s\n' "$CONNECT_ERR" | head -1)"
  case "$CONNECT_ERR" in
    *"password authentication failed"*)
      echo "Пароль не принят. Вставьте его из буфера (правый клик или Ctrl+Shift+V) в английской раскладке."
      echo "Если пароль только что сбрасывали, пулер Supabase несколько минут помнит прежний: подождите"
      echo "и повторите один раз. Много попыток подряд временно блокируют IP (Circuit breaker open)." ;;
    *"Circuit breaker"*)
      echo "Пулер временно закрыл доступ с этого IP после неудачных попыток. Подождите 20 минут." ;;
  esac
  exit 1
fi

umask 077
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

counts() {
  psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c 'SET default_transaction_read_only = on' -f "$BACKUP_DIR/counts.sql" >"$1"
}

if [ "$ACCOUNTS_ONLY" = 0 ]; then
  echo "Подсчёт строк до копии…"
  counts "$BASE.counts-before.tsv"

  echo "Копия схемы public…"
  pg_dump -Fc -n public -f "$BASE.dump.partial"
  mv "$BASE.dump.partial" "$BASE.dump"

  echo "Подсчёт строк после копии…"
  counts "$BASE.counts-after.tsv"
fi

echo "Учётные записи, обложки, опись Supabase…"
psql -X -q -v ON_ERROR_STOP=1 \
  -v users_file="$BASE.auth-users.csv" -v identities_file="$BASE.auth-identities.csv" \
  -v covers_file="$BASE.covers.csv" -v inventory_file="$BASE.inventory.tsv" \
  -f "$BACKUP_DIR/extras.sql"

if [ -n "$CRED_PUB" ]; then
  echo "Отпечатки паролей (запечатываются ключом переноса)…"
  psql -X -q -At -v ON_ERROR_STOP=1 -f "$BACKUP_DIR/credentials.sql" \
    | node migration/accounts/seal.mjs --pub "$CRED_PUB" --out "$BASE.auth-credentials.sealed" --manifest "$BASE.auth-credentials.manifest.json"
fi
if [ "$ACCOUNTS_ONLY" = 1 ]; then
  (cd "$OUT_DIR" && sha256sum "prod-$STAMP.auth-users.csv" "prod-$STAMP.auth-identities.csv" "prod-$STAMP.covers.csv" \
    "prod-$STAMP.inventory.tsv" >"prod-$STAMP.extras.sha256")
  chmod 600 "$BASE".*
  DONE=1
  echo
  echo "Готово: учётные записи и пароли — $BASE.auth-users.csv, $BASE.auth-credentials.sealed (опись рядом)."
  exit 0
fi
(cd "$OUT_DIR" && sha256sum "prod-$STAMP.dump" >"prod-$STAMP.dump.sha256")
(cd "$OUT_DIR" && sha256sum "prod-$STAMP.auth-users.csv" "prod-$STAMP.auth-identities.csv" "prod-$STAMP.covers.csv" \
  "prod-$STAMP.inventory.tsv" >"prod-$STAMP.extras.sha256")
chmod 600 "$BASE".*
DONE=1

TABLES="$(wc -l <"$BASE.counts-before.tsv")"
CHANGED="$(paste "$BASE.counts-before.tsv" "$BASE.counts-after.tsv" | awk -F'\t' '$2 != $4' | wc -l)"
SIZE="$(du -h "$BASE.dump" | cut -f1)"
inv() { awk -F'\t' -v t="$1" '$1 == t { print $2; f = 1 } END { if (!f) print 0 }' "$BASE.inventory.tsv"; }
echo
echo "Готово: $BASE.dump ($SIZE), таблиц: $TABLES, изменились за время копии: $CHANGED."
echo "Учётных записей: $(inv auth.users), способов входа: $(inv auth.identities), обложек: $(inv 'storage.objects[object-photos]')."
echo "Дальше — проверка восстановлением: bash migration/backup/verify.sh $BASE.dump"
