#!/usr/bin/env bash
# Готовность своего входа в базе нового портала — только чтение (sql/check.sql):
#
#   bash migration/accounts/accounts-check.sh <файл подключения>
#
# Её же выполняет deploy-server.sh auth-mode own прямо перед переключением: свой вход включается только при
# свежей проверке без FAIL. В вывод — строки OK / FAIL / INFO, только числа и отпечатки, без почт.
# Выход: 0 — готово; 1 — ошибка запуска; 2 — нет подключения; 3 — не готово (есть FAIL) или чужая база.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$(cd "$HERE/../target" && pwd)"
# shellcheck source=../target/lib/conn.sh
. "$TARGET/lib/conn.sh"
ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] && [ $# -eq 1 ] || { echo "Использование: bash migration/accounts/accounts-check.sh <файл подключения>" >&2; exit 1; }
command -v psql >/dev/null || { echo "Нужен psql" >&2; exit 1; }
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-accounts-check
pin_rc=0; target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) echo "OK база — та, что закреплена отпечатком" ;;
  2) echo "FAIL нет подключения"; exit 2 ;;
  *) echo "FAIL база не закреплена или это другая база"; exit 3 ;;
esac
err="$(mktemp)"; trap 'rm -f -- "$err"; unset PGPASSWORD' EXIT
if ! out="$(psql -X -q -At -v ON_ERROR_STOP=1 -f "$HERE/sql/check.sql" 2>"$err")"; then
  echo "FAIL проверка не выполнена: $(grep -m 1 -E 'ERROR|FATAL' "$err" | sed -E 's/\([^)]*\)/(…)/g' | target_mask | cut -c1-200)"
  exit 3
fi
printf '%s\n' "$out" | grep -E '^(OK|FAIL|INFO) '
if printf '%s\n' "$out" | grep -q '^FAIL '; then echo "ИТОГ: свой вход включать нельзя — исправьте FAIL выше"; exit 3; fi
echo "ИТОГ: свой вход готов к включению"
