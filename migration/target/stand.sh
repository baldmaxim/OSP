#!/usr/bin/env bash
# Локальный стенд «как база Яндекса» из копии прода — для сравнения с настоящей базой (visibility.sh).
#
#   bash migration/target/stand.sh up <копия.dump>   # поднять, загрузить копию, применить права под одну учётку
#   bash migration/target/stand.sh down              # убрать
#
# Стенд — одноразовый контейнер PostgreSQL на этой машине (только 127.0.0.1): одна учётка-владелец без прав
# суперпользователя, ролей Supabase нет. Загрузка и права — теми же инструментами, что и в базе Яндекса
# (pin.sh, load.sh --single-owner, rights.sh). Файл подключения стенда — reports/stand/stand.env (вне git);
# пароли в нём — постоянные проверочные значения, наружу стенд не слушает. Данные копии из контейнера не
# выходят; к базе Яндекса и к Supabase скрипт не подключается.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
STAND_DIR="$REPORT_DIR/stand"
NAME="${STAND_NAME:-osp-target-stand}"
PORT="${STAND_PORT:-24117}" # ниже портов исходящих соединений (32768–60999)
ADMIN_PASS=stand-admin-pass
OWNER_PASS=stand-owner-pass
adm() { PGPASSWORD="$ADMIN_PASS" PGSSLMODE=disable psql -h 127.0.0.1 -p "$PORT" -U postgres -d "${2:-postgres}" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

case "${1:-}" in
  down)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    rm -rf "$STAND_DIR"
    echo "OK стенд убран" ;;
  up)
    DUMP="${2:-}"
    [ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "Нужна копия: bash migration/target/stand.sh up <копия.dump>" >&2; exit 1; }
    for bin in docker psql pg_restore; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:5432" -e "POSTGRES_PASSWORD=$ADMIN_PASS" \
      -e 'POSTGRES_INITDB_ARGS=-E UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8' \
      postgres:17-alpine -c fsync=off -c max_connections=60 >/dev/null
    for _ in $(seq 1 240); do adm 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done
    sleep 1 # образ перезапускает сервер после инициализации
    adm 'select 1' >/dev/null || { echo "FAIL PostgreSQL в Docker не поднялся" >&2; exit 2; }
    adm "create role stand_owner login password '$OWNER_PASS' nosuperuser nocreaterole nocreatedb"
    adm "create database osp_target owner stand_owner"
    adm "revoke connect on database osp_target from public"
    adm "create extension pg_trgm; create extension pgcrypto" osp_target
    mkdir -p "$STAND_DIR"; chmod 700 "$REPORT_DIR" "$STAND_DIR"
    ENV_FILE="$STAND_DIR/stand.env"
    (umask 077; printf '%s\n' 'PGHOST=127.0.0.1' "PGPORT=$PORT" 'PGDATABASE=osp_target' 'PGUSER=stand_owner' "PGPASSWORD=$OWNER_PASS" 'PGSSLMODE=disable' > "$ENV_FILE")
    rm -f "$ENV_FILE.pin"
    export PROBE_REPORT_DIR="$STAND_DIR/reports"
    # Каждый шаг проверяется по коду выхода: при отказе — его причины и остановка.
    step() {
      local out
      if ! out="$(bash "$HERE/$1" "${@:2}" 2>&1)"; then
        printf '%s\n' "$out" | grep -E '^(FAIL|ИНФО причина)' >&2 || printf '%s\n' "$out" | tail -n 3 >&2
        echo "FAIL шаг $1 не прошёл — стенд не готов" >&2
        exit 3
      fi
      printf '%s\n' "$out" | grep -E "$STEP_SHOW" || true
    }
    STEP_SHOW='^OK база закреплена' step pin.sh "$ENV_FILE" --confirm
    STEP_SHOW='^OK загружено' step load.sh "$ENV_FILE" "$DUMP" --status rehearsal --single-owner
    STEP_SHOW='^ИТОГ' step rights.sh "$ENV_FILE" "$DUMP"
    adm 'analyze' osp_target
    echo "OK стенд готов. Файл подключения: ${ENV_FILE#"$PWD"/}" ;;
  *)
    echo "Использование: bash migration/target/stand.sh up <копия.dump> | down" >&2; exit 1 ;;
esac
