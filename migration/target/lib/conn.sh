# Подключение к выданной базе — общее для probe.sh, load.sh, verify.sh, reset.sh.
#
#   target_conn <файл>   — читает PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD / PGSSLMODE
#                          (необязательно PGSSLROOTCERT) и экспортирует их. Файл разбирается, а не
#                          исполняется; остальные строки игнорируются; то, что уже есть в окружении, не
#                          используется. Нет PGPASSWORD — пароль спрашивается скрыто.
#   target_mask          — текст ошибки psql без значений из файла, без IP-адресов и номера порта.
#   target_fingerprint   — отпечаток базы, к которой подключились: sha256 от идентификатора кластера,
#                          номера базы, её имени и владельца. Только чтение; имён не раскрывает.
#   target_pin_check <файл> — сверяет отпечаток с закреплённым (pin.sh пишет его в «<файл>.pin»).
#                          0 — та же база; 1 — отпечаток не закреплён; 2 — нет подключения; 3 — база не та.
#                          Учётка общая на несколько баз: без этого опечатка в файле подключения привела бы
#                          загрузку или очистку в чужую базу.
#
# Корневой сертификат для verify-full: PGSSLROOTCERT из файла, иначе root.crt РЯДОМ с файлом
# подключения (ENV_DIR), иначе место libpq по умолчанию. В ~/.postgresql/root.crt его класть нельзя:
# при этом файле libpq проверяет сертификат и у подключений с sslmode=require — сломаются копии Supabase
# (migration/backup) и подключения других проектов под тем же пользователем.

ENV_DIR=""

target_conn() {
  local file="$1" line key val
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo "Нет файла подключения: нужны PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE" >&2
    return 1
  fi
  unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGSSLROOTCERT PGSERVICE PGOPTIONS PGPASSFILE
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGSSLMODE|PGSSLROOTCERT)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      val="${BASH_REMATCH[3]}"
      if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
      # Хвостовые пробелы — частая ошибка копирования; в пароле не трогаем.
      if [ "$key" != PGPASSWORD ]; then val="${val%"${val##*[![:space:]]}"}"; fi
      printf -v "$key" '%s' "$val"
      export "${key?}"
    fi
  done < "$file"

  for key in PGHOST PGPORT PGDATABASE PGUSER; do
    if [ -z "${!key:-}" ]; then
      echo "В файле нет $key" >&2
      return 1
    fi
  done
  ENV_DIR="$(cd "$(dirname "$file")" && pwd)"
  if [ -z "${PGSSLROOTCERT:-}" ] && [ -f "$ENV_DIR/root.crt" ]; then
    export PGSSLROOTCERT="$ENV_DIR/root.crt"
  fi
  if [ -z "${PGPASSWORD:-}" ]; then
    read -rsp 'Пароль базы (не отображается): ' PGPASSWORD
    echo
    export PGPASSWORD
  fi
  export PGCONNECT_TIMEOUT="${PROBE_CONNECT_TIMEOUT:-10}"
}

target_mask() {
  local text value
  text="$(cat)"
  for value in "${PGPASSWORD:-}" ${PGHOST//,/ } "${PGUSER:-}" "${PGDATABASE:-}"; do
    if [ -n "$value" ]; then text="${text//"$value"/***}"; fi
  done
  printf '%s\n' "$text" | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/***/g; s/[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{0,4}){3,7}/***/g; s/port [0-9]+/port ***/g'
}

target_fingerprint() {
  psql -X -q -At -v ON_ERROR_STOP=1 -c "
    select encode(sha256(convert_to(c.system_identifier::text || '|' || d.oid::text || '|' || d.datname::text
                                    || '|' || pg_get_userbyid(d.datdba)::text, 'UTF8')), 'hex')
    from pg_control_system() c, pg_database d where d.datname = current_database()"
}

target_pin_check() {
  local pin="$1.pin" want got
  [ -f "$pin" ] || return 1
  want="$(grep -m 1 -oE '^[0-9a-f]{64}$' "$pin" || true)"
  [ -n "$want" ] || return 1
  got="$(target_fingerprint 2>/dev/null)" || return 2
  [ "$got" = "$want" ] || return 3
  return 0
}
