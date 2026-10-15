#!/usr/bin/env bash
# Перенос учёток и паролей из выгрузки Supabase в базу нового портала (свой вход tender.su10.ru). Из корня
# репозитория; на сервере corp — через scripts/deploy-server.sh accounts-sync (в контейнере инструментов):
#
#   bash migration/accounts/accounts-sync.sh <файл подключения> --users <prod-*.auth-users.csv> \
#        --credentials <prod-*.auth-credentials.sealed> --transfer-key <accounts-transfer.key> \
#        --auth-keys-file <osp-api.env> [--manifest <опись.json>] [--restore <uuid>] --dry-run | --yes
#
# Выгрузки снимает migration/backup/backup.sh --credentials <открытый ключ переноса> (Supabase только читается).
# Что делает (одна транзакция, sql/sync.sql):
#   • учётки: новые добавляются; у существующих обновляются почта, подтверждение, данные регистрации;
#     удалённые в Supabase и удалённые администратором в новом портале (надгробия) не воссоздаются;
#   • пароли: новые — вставка; изменённые в Supabase после прошлой копии (до переключения tender.su10.ru на
#     свой вход) — замена, только у паролей, заданных в Supabase; сессии с прежним
#     паролем отзываются; сменённые в новом портале не трогаются;
#   • дубли почты — остановка до записи; канарейка ключа сервера и отпечаток выгрузки — в osp_auth.meta.
# Повтор безопасен. --dry-run — тот же расчёт с откатом в конце. --yes: снимок соседей и копия базы до
# записи, сравнение соседей после. В вывод и отчёт — только счётчики. Выход: 0 — сделано; 1 — ошибка запуска;
# 2 — нет подключения; 3 — отказ до записи; 4 — транзакция отменена.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$(cd "$HERE/../target" && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$TARGET/reports}"
# shellcheck source=../target/lib/conn.sh
. "$TARGET/lib/conn.sh"

usage() {
  echo "Использование: bash migration/accounts/accounts-sync.sh <файл подключения> --users <csv> --credentials <sealed> --transfer-key <pem> --auth-keys-file <env> [--manifest <json>] [--restore <uuid>] --dry-run | --yes" >&2
  exit 1
}
ENV_FILE="${1:-}"; [ -n "$ENV_FILE" ] || usage; shift
USERS="" CRED="" TKEY="" KEYS_FILE="" MANIFEST="" RESTORE="" MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --users) USERS="${2:-}"; shift 2 ;;
    --credentials) CRED="${2:-}"; shift 2 ;;
    --transfer-key) TKEY="${2:-}"; shift 2 ;;
    --auth-keys-file) KEYS_FILE="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --restore) RESTORE="${2:-}"; shift 2 ;;
    --dry-run | --yes) MODE="$1"; shift ;;
    *) usage ;;
  esac
done
[ -n "$USERS" ] && [ -n "$CRED" ] && [ -n "$TKEY" ] && [ -n "$KEYS_FILE" ] && [ -n "$MODE" ] || usage
for f in "$USERS" "$CRED" "$TKEY" "$KEYS_FILE" ${MANIFEST:+"$MANIFEST"}; do [ -r "$f" ] || { echo "Нет файла: $f" >&2; exit 1; }; done
case "$USERS" in *[[:space:]\']*) echo "Путь выгрузки учёток не должен содержать пробелов и кавычек" >&2; exit 1 ;; esac
if [ -n "$RESTORE" ] && ! [[ "$RESTORE" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "--restore: идентификатор учётки (uuid)" >&2; exit 1
fi
for bin in psql node sha256sum; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-accounts-sync

WORK="$(mktemp -d)"; chmod 700 "$WORK"
REPORT=""
trap 'rm -rf -- "$WORK"; unset PGPASSWORD' EXIT
say() { REPORT+="$1"$'\n'; printf '%s\n' "$1"; }
save_report() {
  mkdir -p "$REPORT_DIR"; chmod 700 "$REPORT_DIR"
  local file="$REPORT_DIR/accounts-sync-$(date -u +%Y%m%d-%H%M%S).txt"
  (umask 077; printf '%s' "$REPORT" > "$file")
  echo "Отчёт сохранён: ${file#"$PWD"/}"
}
stop() { say "$2"; save_report; exit "$1"; }
first_error() {
  grep -m 1 -E 'ERROR:|FATAL:|error:|FAIL' "$1" | sed -E 's/^.*(ERROR|FATAL|error): */\1: /; s/\([^)]*\)/(…)/g' | target_mask | cut -c1-240
}

say "Перенос учёток в базу нового портала ($MODE). $(date -u '+%Y-%m-%d %H:%M') UTC"
pin_rc=0; target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) say "OK база — та, что закреплена отпечатком" ;;
  2) stop 2 "FAIL нет подключения: отпечаток базы не прочитан" ;;
  *) stop 3 "FAIL база не закреплена или это другая база — ничего не изменено" ;;
esac
if ! mark="$(psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "select rights, (finished_at is not null) from osp_meta.load_log order by id desc limit 1" 2>"$WORK/err")" || [ -z "$mark" ]; then
  stop 3 "FAIL в базе нет отметки загрузки — это не база портала после переноса"
fi
IFS=$'\t' read -r RIGHTS FINISHED <<< "$mark"
[ "$RIGHTS" = single ] && [ "$FINISHED" = t ] || stop 3 "FAIL права под одну учётку не применены или загрузка не завершена — перенос учёток не к месту"
[ "$(psql -X -q -At -c "select to_regnamespace('osp_auth') is not null and to_regnamespace('osp_session') is not null" 2>/dev/null)" = t ] \
  || stop 3 "FAIL схем своего входа нет — сначала миграция 20261019_own_auth (deploy-server.sh migrate)"

# Колонки выгрузки учёток — только из закрытого списка (тот же, что у load.sh --auth).
if ! COLS="$(node --input-type=module -e "
  import fs from 'node:fs'
  import { csvHeader, checkColumns, USER_COLUMNS, USER_REQUIRED } from '$TARGET/lib/extras.mjs'
  process.stdout.write(checkColumns(csvHeader(fs.readFileSync(process.argv[1], 'utf8')), USER_COLUMNS, USER_REQUIRED, 'учётные записи').join(', '))
" "$USERS" 2>"$WORK/err")"; then
  stop 3 "FAIL выгрузка учёток: $(first_error "$WORK/err")"
fi
if ! prep="$(node "$HERE/prepare.mjs" --credentials "$CRED" --transfer-key "$TKEY" --auth-keys-file "$KEYS_FILE" \
    --out "$WORK/cred.csv" --canary-out "$WORK/canary.txt" ${MANIFEST:+--manifest "$MANIFEST"} 2>"$WORK/err")"; then
  stop 3 "FAIL пароли не подготовлены: $(first_error "$WORK/err")"
fi
say "$(printf '%s\n' "$prep" | sed -E 's/(отпечаток учёток [0-9a-f]{16})[0-9a-f]*/\1…/')"
FP="$(printf '%s\n' "$prep" | grep -o 'отпечаток учёток [0-9a-f]\{64\}' | awk '{ print $3 }')"
[ -n "$FP" ] || stop 3 "FAIL отпечаток учёток не получен"

if [ "$MODE" = --yes ]; then
  if ! out="$(bash "$TARGET/neighbors.sh" "$ENV_FILE" --save 2>&1)"; then say "$out"; stop 3 "FAIL снимок соседей не снят — ничего не изменено"; fi
  say "OK снимок соседей по кластеру снят"
  if ! out="$(bash "$TARGET/export.sh" "$ENV_FILE" 2>&1)"; then
    say "$(printf '%s\n' "$out" | grep -E '^(FAIL|OK)' | head -n 3)"
    stop 3 "FAIL копия базы не снята — ничего не изменено"
  fi
  say "OK копия базы перед переносом учёток: $(printf '%s\n' "$out" | grep -m 1 -E '^Каталог:' | sed 's/^Каталог: //')"
fi

# \copy не подставляет переменные psql — команды с путями пишутся в файл (пути проверены выше: без пробелов
# и кавычек; каталог работы — mktemp).
USERS_ABS="$(cd "$(dirname "$USERS")" && pwd)/$(basename "$USERS")"
case "$USERS_ABS$WORK" in *[[:space:]\'\\]*) stop 1 "FAIL путь выгрузки или временного каталога содержит пробел, кавычку или \\" ;; esac
{
  printf "\\copy in_users (%s) FROM '%s' WITH (FORMAT csv, HEADER true)\n" "$COLS" "$USERS_ABS"
  printf "\\copy in_cred FROM '%s' WITH (FORMAT csv, HEADER true)\n" "$WORK/cred.csv"
} > "$WORK/copy.psql"
rc=0
psql -X -q -At -v ON_ERROR_STOP=1 \
  -v copy_file="$WORK/copy.psql" \
  -v canary="$(cat "$WORK/canary.txt")" -v fingerprint="$FP" -v users_sha="$(sha256sum "$USERS" | cut -d' ' -f1)" \
  -v restore_id="${RESTORE:-00000000-0000-0000-0000-000000000000}" -v has_restore="$([ -n "$RESTORE" ] && echo true || echo false)" \
  -v commit="$([ "$MODE" = --yes ] && echo true || echo false)" \
  -f "$HERE/sql/sync.sql" > "$WORK/out" 2> "$WORK/err" || rc=$?
counters="$(grep '^OSP_SYNC ' "$WORK/out" | sed 's/^OSP_SYNC /  /' || true)"
[ -z "$counters" ] || say "$counters"
if grep -q '^OSP_SYNC_FAIL_DUP_EMAILS$' "$WORK/out"; then
  stop 3 "FAIL одна почта у нескольких учёток (после нормализации) — ничего не изменено; разобраться в Supabase"
fi
[ "$rc" = 0 ] || stop 4 "FAIL ошибка — транзакция отменена: $(first_error "$WORK/err")"
if grep -q '^OSP_SYNC_DRY_RUN$' "$WORK/out"; then
  stop 0 "ИТОГ: проверка — ничего не изменено. Записать: тот же запуск с --yes."
fi
grep -q '^OSP_SYNC_COMMITTED$' "$WORK/out" || stop 4 "FAIL транзакция не подтверждена"
if ! out="$(bash "$TARGET/neighbors.sh" "$ENV_FILE" --compare 2>&1)"; then
  say "$out"; stop 3 "ИТОГ: учётки перенесены, но сравнение соседей дало замечания — разобраться до дальнейших шагов."
fi
say "OK соседи по кластеру не изменились"
stop 0 "ИТОГ: учётки и пароли перенесены. Файлы выгрузки с отпечатками удалите с этого сервера."
