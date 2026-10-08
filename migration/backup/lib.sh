# Общие функции verify.sh и rehearse.sh: одноразовый PostgreSQL в Docker,
# заглушки Supabase, восстановление копии, подсчёт строк.
#
# В вывод попадают только имена таблиц, числа и заголовки ошибок без подробностей:
# в DETAIL/строках COPY бывают значения из данных (email, ФИО).
# Подключение к временной базе идёт со своими параметрами — переменные PG* прода
# (пароль, sslmode), если они заданы в окружении, сюда не попадают.

BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
LOCAL_PORT=""
LOCAL_CONTAINER=""

local_psql() {
  PGPASSWORD='' PGSSLMODE=disable psql -h 127.0.0.1 -p "$LOCAL_PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
}

pg_start() {
  LOCAL_PORT=$((55000 + RANDOM % 5000))
  LOCAL_CONTAINER="osp-backup-check-$$-$LOCAL_PORT"
  docker run -d --rm --name "$LOCAL_CONTAINER" -p "127.0.0.1:$LOCAL_PORT:5432" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e 'POSTGRES_INITDB_ARGS=-E UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8' \
    "$PG_IMAGE" -c fsync=off -c max_connections=40 >/dev/null
  local i
  for i in $(seq 1 240); do
    if [ "$(local_psql -At -c 'select 1' 2>/dev/null)" = "1" ]; then return 0; fi
    sleep 0.5
  done
  echo "Временный PostgreSQL не поднялся" >&2
  return 1
}

pg_stop() {
  if [ -n "$LOCAL_CONTAINER" ]; then docker rm -f "$LOCAL_CONTAINER" >/dev/null 2>&1 || true; fi
}

# Расширения — в ту схему, на которую ссылается копия (в Supabase обычно extensions).
install_extensions() {
  local dump="$1" ddl ext marker schema
  ddl="$(mktemp)"
  pg_restore --schema-only -f "$ddl" "$dump" 2>/dev/null || true
  for ext in pg_trgm pgcrypto uuid-ossp citext unaccent; do
    case "$ext" in
      pg_trgm)   marker='(gin|gist)_trgm_ops|similarity\(|word_similarity' ;;
      pgcrypto)  marker='gen_salt\(|crypt\(|digest\(|hmac\(|pgp_sym' ;;
      uuid-ossp) marker='uuid_generate_v[1-5]' ;;
      citext)    marker='citext' ;;
      unaccent)  marker='unaccent\(' ;;
    esac
    if grep -Eq "public\.($marker)" "$ddl"; then schema=public
    elif grep -Eq "extensions\.($marker)" "$ddl"; then schema=extensions
    elif grep -Eq "($marker)" "$ddl"; then schema=extensions
    else continue
    fi
    local_psql -c "CREATE EXTENSION IF NOT EXISTS \"$ext\" WITH SCHEMA $schema" >/dev/null
  done
  # gen_random_uuid() встроен в PG 13+; pgcrypto ставим всегда — его функции ждут многие миграции.
  local_psql -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions' >/dev/null 2>&1 || true
  local_psql -c "ALTER DATABASE postgres SET search_path = \"\$user\", public, extensions" >/dev/null
  rm -f "$ddl"
}

# Восстановление копии. Возвращает число ошибок в RESTORE_ERRORS, журнал — в $2.
restore_dump() {
  local dump="$1" log="$2"
  local_psql -f "$BACKUP_DIR/stubs.sql" >/dev/null 2>&1
  install_extensions "$dump"
  # Схема public во временной базе уже есть — её создание из копии пропускаем,
  # иначе ложная ошибка «schema public already exists». Остальное — как в копии.
  local list
  list="$(mktemp)"
  pg_restore --list "$dump" | grep -v ' SCHEMA - public ' >"$list"
  PGPASSWORD='' PGSSLMODE=disable pg_restore -h 127.0.0.1 -p "$LOCAL_PORT" -U postgres -d postgres \
    --no-owner --no-privileges -j 4 -L "$list" "$dump" >"$log" 2>&1 || true
  rm -f "$list"
  chmod 600 "$log"
  RESTORE_ERRORS="$(grep -c '^pg_restore: error' "$log" || true)"
}

# Заголовки ошибок без подробностей и значений.
print_errors() {
  local log="$1"
  grep '^pg_restore: error' "$log" | sed -E 's/(DETAIL|Key \(|CONTEXT|LINE [0-9]+).*$//' | cut -c1-200 | sort | uniq -c | head -40
}

# Число строк по таблицам временной базы → файл "таблица<TAB>число".
local_counts() {
  local_psql -At -F $'\t' -f "$BACKUP_DIR/counts.sql" >"$1"
}
