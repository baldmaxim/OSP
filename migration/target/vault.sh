#!/usr/bin/env bash
# Учётные записи с отпечатками паролей в базе Яндекса (схема osp_vault, load.sh --auth). ТОЛЬКО ЧТЕНИЕ.
#
#   bash migration/target/vault.sh <файл подключения> status
#
# Отпечатки сняты с копии, а вход до перехода в Keycloak остаётся в Supabase Auth: кто сменит пароль
# или заведёт учётку позже, у того отпечатка в osp_vault нет или он устарел. Копия учёток без паролей
# (auth.users) обновляется из Supabase Auth сама (osp-api), по её дате изменения это и видно:
#   • учёток в osp_vault и в копии auth.users;
#   • в копии есть, в osp_vault нет — новые учётки;
#   • в копии изменены позже, чем в osp_vault, — пароль мог смениться.
# Перед переходом входа в Keycloak отпечатки снимаются заново, и оба числа должны стать нулём.
# В вывод — только числа. Выход: 0 — прочитано; 1 — ошибка запуска; 2 — нет подключения; 3 — не та база
# или учётки не загружались.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"

usage() { echo "Использование: bash migration/target/vault.sh <файл подключения> status" >&2; exit 1; }
ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] && [ "${2:-}" = status ] && [ $# -eq 2 ] || usage
command -v psql >/dev/null || { echo "Нужен psql" >&2; exit 1; }
target_conn "$ENV_FILE" || exit 1
trap 'unset PGPASSWORD' EXIT

pin_rc=0; target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) ;;
  2) echo "FAIL нет подключения: отпечаток базы не прочитан"; exit 2 ;;
  *) echo "FAIL база не закреплена или это другая база"; exit 3 ;;
esac

# Отметка osp:vault — только внутри этой транзакции «только чтение». Копия auth.users появляется с
# правами под одну учётку (rights.sh); до этого шага статус не читается.
if ! out="$(psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 2>/dev/null <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT to_regnamespace('osp_vault') IS NOT NULL AS has_vault \gset
\if :has_vault
-- Копия auth.users закрыта пропуском служебного ключа (load-single-owner.sql), osp_vault — своей отметкой.
SELECT pg_catalog.set_config('application_name', 'osp:vault', true),
       pg_catalog.set_config('request.jwt.claims', '{"role":"service_role","osp_role":"service_role"}', true) \gset ignored_
SELECT (SELECT count(*) FROM osp_vault.users),
       (SELECT count(*) FROM auth.users),
       (SELECT count(*) FROM auth.users a WHERE NOT EXISTS (SELECT 1 FROM osp_vault.users v WHERE v.id = a.id)),
       (SELECT count(*) FROM auth.users a JOIN osp_vault.users v ON v.id = a.id WHERE a.updated_at > v.updated_at),
       (SELECT source_name || ' (' || to_char(loaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC)' FROM osp_vault.copy_log ORDER BY id DESC LIMIT 1);
\else
SELECT 'none';
\endif
COMMIT;
SQL
)"; then
  echo "FAIL нет подключения или чтение не выполнилось"
  exit 2
fi
if [ "$out" = none ]; then
  echo "FAIL учётки с отпечатками паролей в эту базу не загружались (load.sh без --auth)"
  exit 3
fi
IFS=$'\t' read -r IN_VAULT IN_MIRROR NEW_USERS CHANGED SOURCE <<< "$out"
echo "Учётки с отпечатками паролей (osp_vault): $IN_VAULT, сняты с копии $SOURCE"
echo "Копия учёток без паролей (auth.users): $IN_MIRROR"
echo "Новые учётки — отпечатков нет: $NEW_USERS"
echo "Изменены позже снятия отпечатков — пароль мог смениться: $CHANGED"
if [ "$NEW_USERS" = 0 ] && [ "$CHANGED" = 0 ]; then
  echo "ИТОГ: отпечатки актуальны."
else
  echo "ИТОГ: перед переходом входа в Keycloak снять отпечатки заново."
fi
