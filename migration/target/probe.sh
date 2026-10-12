#!/usr/bin/env bash
# Разведка выданной базы PostgreSQL — ТОЛЬКО ЧТЕНИЕ. Запускать на удалённой машине из корня
# репозитория:
#
#   bash migration/target/probe.sh ~/.osp-secrets/target.env
#
# Файл — строки PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD / PGSSLMODE (необязательно
# PGSSLROOTCERT). Он разбирается, а не исполняется; остальные строки игнорируются. Нет PGPASSWORD —
# пароль спрашивается скрыто.
#
# Что делает: подключается к ОДНОЙ базе — той, что в файле, — и читает системные каталоги внутри
# транзакции «только чтение» (probe.sql). Ничего не создаёт и не меняет: в кластере рядом базы других
# порталов.
# Что печатает: строки OK / ВНИМАНИЕ / FAIL / ИНФО. Пароль, адрес и имя пользователя не печатаются;
# имена базы и роли — только если они из нашей заявки владельцу кластера
# (migration/requests/cluster-owner.md). Тот же текст — в migration/target/reports/probe-<время>.txt
# (вне git, права 600).
# Выход: 0 — отчёт получен; 2 — подключиться не удалось; 1 — ошибка запуска.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
ENV_FILE="${1:-}"

if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "Использование: bash migration/target/probe.sh <файл с PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE>" >&2
  exit 1
fi
command -v psql >/dev/null || { echo "Нужен psql" >&2; exit 1; }

# Подключение — только из файла: то, что уже есть в окружении, сюда не попадает.
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
done < "$ENV_FILE"

for key in PGHOST PGPORT PGDATABASE PGUSER; do
  [ -n "${!key:-}" ] || { echo "В файле нет $key" >&2; exit 1; }
done
if [ -z "${PGPASSWORD:-}" ]; then
  read -rsp 'Пароль базы (не отображается): ' PGPASSWORD
  echo
  export PGPASSWORD
fi
export PGCONNECT_TIMEOUT="${PROBE_CONNECT_TIMEOUT:-10}"
export PGAPPNAME=osp-probe-readonly

ERR="$(mktemp)"
REPORT=""
cleanup() {
  rm -f -- "$ERR"
  unset PGPASSWORD
}
trap cleanup EXIT

say() {
  REPORT+="$1"$'\n'
  printf '%s\n' "$1"
}

# Текст ошибки psql без значений из файла и без IP-адресов.
mask() {
  local text value
  text="$(cat)"
  for value in "${PGPASSWORD:-}" ${PGHOST//,/ } "${PGUSER:-}" "${PGDATABASE:-}"; do
    if [ -n "$value" ]; then text="${text//"$value"/***}"; fi
  done
  printf '%s\n' "$text" | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/***/g; s/[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{0,4}){3,7}/***/g; s/port [0-9]+/port ***/g'
}

save_report() {
  mkdir -p "$REPORT_DIR"
  chmod 700 "$REPORT_DIR"
  local file
  file="$REPORT_DIR/probe-$(date -u +%Y%m%d-%H%M%S).txt"
  (umask 077; printf '%s' "$REPORT" > "$file")
  echo "Отчёт сохранён: ${file#"$PWD"/}"
}

say "Разведка базы — только чтение. $(date -u '+%Y-%m-%d %H:%M') UTC"

case "${PGHOST,,}" in
  *.yandexcloud.net) zone='Яндекс Managed PostgreSQL (*.yandexcloud.net)' ;;
  *.supabase.com | *.supabase.co) zone='Supabase (*.supabase.com)' ;;
  localhost | 127.* | ::1) zone='эта же машина' ;;
  *) zone='другой адрес (не показываю)' ;;
esac
case "$PGPORT" in
  6432) port_note='порт 6432 — пулер соединений (в Яндексе — Odyssey)' ;;
  5432) port_note='порт 5432' ;;
  6543) port_note='порт 6543 — пулер Supabase в режиме транзакций' ;;
  *) port_note='порт нестандартный (не показываю)' ;;
esac
say "ИНФО адрес: $zone; $port_note"

case "${PGSSLMODE:-}" in
  verify-full) say 'OK TLS в файле: verify-full — сертификат и имя сервера проверяются' ;;
  verify-ca) say 'ВНИМАНИЕ TLS в файле: verify-ca — имя сервера не сверяется (в заявке — verify-full)' ;;
  require) say 'ВНИМАНИЕ TLS в файле: require — шифрование есть, сертификат сервера не проверяется (в заявке — verify-full)' ;;
  disable | allow | prefer) say "ВНИМАНИЕ TLS в файле: $PGSSLMODE — шифрование не обязательно" ;;
  '') say 'ВНИМАНИЕ TLS в файле не задан (PGSSLMODE)' ;;
  *) say 'ВНИМАНИЕ TLS в файле: неизвестный режим' ;;
esac

connect_failed() {
  local text
  text="$(cat "$ERR")"
  case "$text" in
    *'root certificate file'*'does not exist'*)
      say 'FAIL нет корневого сертификата для проверки TLS на этой машине'
      say 'ИНФО сертификат Яндекса: mkdir -p ~/.postgresql && curl -fsS https://storage.yandexcloud.net/cloud-certs/CA.pem -o ~/.postgresql/root.crt && chmod 600 ~/.postgresql/root.crt' ;;
    *'certificate verify failed'* | *'server certificate'* | *'SSL error'*)
      say 'FAIL проверка TLS-сертификата сервера не прошла' ;;
    *'server does not support SSL'*)
      say 'FAIL сервер не поддерживает шифрование, а в файле оно обязательно' ;;
    *'authentication failed'*)
      say 'FAIL вход не выполнен: пароль или имя роли не подошли' ;;
    *'timeout expired'* | *'timed out'* | *'No route to host'* | *'Network is unreachable'*)
      say 'FAIL нет связи с этой машины: сервер не ответил за отведённое время' ;;
    *'could not translate host name'* | *'Name or service not known'* | *'name resolution'*)
      say 'FAIL адрес сервера не находится (DNS) с этой машины' ;;
    *'Connection refused'*)
      say 'FAIL соединение отклонено: порт закрыт или сервер не слушает' ;;
    *'database "'*'" does not exist'* | *'role "'*'" does not exist'*)
      say 'FAIL базы или роли с таким именем на сервере нет' ;;
    *'no pg_hba.conf entry'* | *'not permitted to log in'*)
      say 'FAIL сервер не разрешает этот вход: правила доступа или запрет входа для роли' ;;
    *'too many connections'* | *'connection limit exceeded'*)
      say 'FAIL лимит соединений исчерпан' ;;
    *)
      say "FAIL ошибка подключения: $(head -n 3 "$ERR" | mask | tr '\n' ' ')" ;;
  esac
}

if ! conn="$(psql -X -q -At -c '\conninfo' -c 'select 1' 2>"$ERR")"; then
  connect_failed
  save_report
  exit 2
fi
tls="$(printf '%s\n' "$conn" | grep -oE 'TLSv[0-9.]+' | head -n 1 || true)"
if [ -n "$tls" ]; then
  say "OK подключение установлено; шифрование $tls"
else
  say 'ВНИМАНИЕ подключение установлено без шифрования'
fi

if [ "${PGSSLMODE:-}" != verify-full ]; then
  ca="${PGSSLROOTCERT:-$HOME/.postgresql/root.crt}"
  if [ ! -f "$ca" ]; then
    say 'ИНФО verify-full не пробовали: на этой машине нет корневого сертификата (~/.postgresql/root.crt)'
  elif PGSSLMODE=verify-full PGSSLROOTCERT="$ca" psql -X -q -At -c 'select 1' >/dev/null 2>&1; then
    say 'OK с проверкой сертификата (verify-full) подключение тоже проходит — режим в файле можно ужесточить'
  else
    say 'ВНИМАНИЕ с проверкой сертификата (verify-full) подключение не проходит'
  fi
fi

status=0
if out="$(psql -X -q -At -v ON_ERROR_STOP=1 -f "$HERE/probe.sql" 2>"$ERR")"; then
  while IFS= read -r line; do
    case "$line" in
      OK* | ВНИМАНИЕ* | FAIL* | ИНФО*) say "$line" ;;
    esac
  done <<< "$out"
else
  say "FAIL разведка прервана: $(head -n 3 "$ERR" | mask | tr '\n' ' ')"
  status=2
fi

# Режим пулера: в режиме транзакций состояние сеанса (подготовленный запрос) не переживает транзакцию.
# Данные это не трогает. Окончательный ответ — настройка роли у владельца кластера.
if psql -X -q -At -c 'PREPARE osp_probe_stmt AS SELECT 1' -c 'EXECUTE osp_probe_stmt' -c 'DEALLOCATE osp_probe_stmt' >/dev/null 2>"$ERR"; then
  say 'ИНФО пулер: признаков режима транзакций нет — состояние сеанса сохранилось (session или прямое подключение; нужен для pg_dump и восстановления)'
elif grep -q 'prepared statement .* does not exist' "$ERR"; then
  say 'ИНФО пулер: режим транзакций — состояние сеанса не сохраняется (для pg_dump и восстановления нужен session)'
else
  say 'ИНФО пулер: режим определить не удалось'
fi

save_report
exit "$status"
