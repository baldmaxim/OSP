#!/usr/bin/env bash
# Закрепить базу: записать её отпечаток рядом с файлом подключения. ТОЛЬКО ЧТЕНИЕ базы.
# Запускать на удалённой машине из корня репозитория, один раз после разведки (probe.sh):
#
#   bash migration/target/pin.sh <файл подключения>             # показать, что будет закреплено
#   bash migration/target/pin.sh <файл подключения> --confirm   # записать «<файл подключения>.pin»
#
# Зачем: учётка из файла подключения открывает несколько баз кластера. load.sh и reset.sh работают
# только с базой, чей отпечаток закреплён: другой адрес, другая база или другой владелец — отказ до
# первой записи. Отпечаток — sha256 от идентификатора кластера, номера базы, её имени и владельца;
# сами имена в вывод и в файл не попадают.
# Выход: 0 — показано или закреплено; 1 — ошибка запуска; 2 — нет подключения; 3 — закреплена другая база.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"

ENV_FILE="${1:-}"
CONFIRM="${2:-}"
if [ -z "$ENV_FILE" ] || { [ -n "$CONFIRM" ] && [ "$CONFIRM" != "--confirm" ]; } || [ $# -gt 2 ]; then
  echo "Использование: bash migration/target/pin.sh <файл подключения> [--confirm]" >&2
  exit 1
fi
command -v psql >/dev/null || { echo "Нужен psql" >&2; exit 1; }
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-pin-readonly
PIN="$ENV_FILE.pin"

ERR="$(mktemp)"
trap 'rm -f -- "$ERR"; unset PGPASSWORD' EXIT
if ! print="$(target_fingerprint 2>"$ERR")" || ! [[ "$print" =~ ^[0-9a-f]{64}$ ]]; then
  echo "FAIL нет подключения или отпечаток не прочитан: $(head -n 1 "$ERR" | target_mask | cut -c1-200)"
  exit 2
fi

# Что это за база — без имён: те же признаки, что в разведке.
psql -X -q -At -v ON_ERROR_STOP=1 -c "
  begin transaction read only;
  select 'ИНФО в имени базы есть «osp»: ' || case when current_database() ~* 'osp' then 'да' else 'нет' end
      || '; роль — владелец базы: ' || case when d.datdba = r.oid then 'да' else 'нет' end
  from pg_database d, pg_roles r where d.datname = current_database() and r.rolname = current_user;
  select 'ИНФО таблиц и представлений в базе: ' || count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
    and not exists (select 1 from pg_depend x where x.classid = 'pg_class'::regclass and x.objid = c.oid and x.deptype = 'e');
  rollback;" 2>"$ERR" || { echo "FAIL признаки базы не прочитаны: $(head -n 1 "$ERR" | target_mask | cut -c1-200)"; exit 2; }
echo "ИНФО отпечаток базы: ${print:0:12}…"

if [ -f "$PIN" ]; then
  if [ "$(grep -m 1 -oE '^[0-9a-f]{64}$' "$PIN" || true)" = "$print" ]; then
    echo "OK эта база уже закреплена"
    exit 0
  fi
  echo "FAIL закреплена другая база: отпечаток в $(basename "$PIN") не совпадает. Если так задумано — удалите этот файл вручную и повторите"
  exit 3
fi
if [ "$CONFIRM" != "--confirm" ]; then
  echo "Не закреплено. Если это база портала — повторите с --confirm"
  exit 0
fi
(umask 077; printf '%s\n' "$print" > "$PIN")
echo "OK база закреплена: $(basename "$PIN") (доступ — только владельцу файла)"
