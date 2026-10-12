#!/usr/bin/env bash
# Загрузка проверенной копии прода в выданную базу — ОДНОЙ ТРАНЗАКЦИЕЙ: либо загружено всё, либо
# в базе не изменилось ничего. Запускать на удалённой машине из корня репозитория:
#
#   bash migration/target/load.sh <файл подключения> <копия.dump> --status rehearsal
#   bash migration/target/load.sh <файл подключения> <копия.dump> --status final
#
# rehearsal — репетиция: загруженное можно убрать (reset.sh). final — настоящий перенос: после него
# reset.sh отказывает всегда.
#
# Что делает:
#   1. Проверки без записи (sql/load-preflight.sql): роль — владелец базы; роль приложения есть и не
#      владеет ничем; расширения включены; база пустая. Любой отказ — загрузка не начинается.
#   2. Копия — только проверенная (рядом лежит отметка .verified от migration/backup/verify.sh).
#   3. Данные, таблицы, функции, индексы — как в копии, без правок. Права и политики — с заменой роли
#      Supabase authenticated на роль приложения; anon и service_role не переносятся (lib/rewrite.mjs).
#   4. Одна транзакция: схема auth (compat/auth.sql), отметка и часовой пояс UTC (sql/load-begin.sql),
#      копия, права, перечень созданного (sql/load-end.sql).
# Ролей и расширений не создаёт: в Яндексе это делается в консоли.
# В вывод и отчёт (migration/target/reports/load-<время>.txt) идут только счётчики и имена объектов.
# Выход: 0 — загружено; 1 — ошибка запуска; 2 — нет подключения; 3 — проверки не пройдены;
#        4 — загрузка прервана, транзакция отменена.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"

usage() {
  echo "Использование: bash migration/target/load.sh <файл подключения> <копия.dump> --status rehearsal|final [--runtime-role osp_runtime]" >&2
  exit 1
}

ENV_FILE="${1:-}"
DUMP="${2:-}"
[ -n "$ENV_FILE" ] && [ -n "$DUMP" ] || usage
shift 2
STATUS=""
RUNTIME_ROLE="osp_runtime"
while [ $# -gt 0 ]; do
  case "$1" in
    --status) STATUS="${2:-}"; shift 2 ;;
    --runtime-role) RUNTIME_ROLE="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
case "$STATUS" in rehearsal | final) ;; *) usage ;; esac
[[ "$RUNTIME_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Недопустимое имя роли приложения" >&2; exit 1; }
for bin in psql pg_restore node sha256sum; do
  command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }
done
[ -f "$DUMP" ] || { echo "Нет копии: $DUMP" >&2; exit 1; }
if [ ! -f "${DUMP%.dump}.verified" ]; then
  echo "Копия не проверена восстановлением: сначала bash migration/backup/verify.sh $DUMP" >&2
  exit 1
fi

target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-load

WORK="$(mktemp -d)"
chmod 700 "$WORK"
REPORT=""
cleanup() {
  # Во временном каталоге — SQL копии с данными пользователей.
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi
  unset PGPASSWORD
}
trap cleanup EXIT

say() {
  REPORT+="$1"$'\n'
  printf '%s\n' "$1"
}
save_report() {
  mkdir -p "$REPORT_DIR"
  chmod 700 "$REPORT_DIR"
  local file
  file="$REPORT_DIR/load-$(date -u +%Y%m%d-%H%M%S).txt"
  (umask 077; printf '%s' "$REPORT" > "$file")
  echo "Отчёт сохранён: ${file#"$PWD"/}"
}
# Первая строка ошибки без значений из данных: содержимое кавычек скрыто.
first_error() {
  grep -m 1 -E 'ERROR:|FATAL:|error:' "$1" | sed -E 's/^.*(ERROR|FATAL|error): */\1: /; s/"[^"]*"/"…"/g; s/\([^)]*\)/(…)/g' | target_mask | cut -c1-240
}

SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
say "Загрузка копии в выданную базу — статус $STATUS. $(date -u '+%Y-%m-%d %H:%M') UTC"
say "ИНФО копия: $(basename "$DUMP"), sha256 ${SHA:0:12}…; роль приложения: $RUNTIME_ROLE"

# 1. Проверки без записи.
if ! pre="$(psql -X -q -At -v ON_ERROR_STOP=1 -v runtime_role="$RUNTIME_ROLE" -f "$HERE/sql/load-preflight.sql" 2>"$WORK/err")"; then
  say "FAIL нет подключения или проверки не выполнились: $(first_error "$WORK/err")"
  save_report
  exit 2
fi
failed=0
while IFS= read -r line; do
  case "$line" in
    OK*) say "$line" ;;
    FAIL*) say "$line"; failed=1 ;;
  esac
done <<< "$pre"
if [ "$failed" = 1 ]; then
  say "Загрузка не начата: в базе ничего не изменилось."
  save_report
  exit 3
fi

# 2. Копия → SQL: основное без правок, права — с заменой ролей.
pg_restore --list "$DUMP" > "$WORK/toc"
node "$HERE/lib/rewrite.mjs" split "$WORK/toc" "$WORK/main.list" "$WORK/acl.list" "$WORK/split.json"
pg_restore --no-owner -L "$WORK/main.list" -f "$WORK/main.sql" "$DUMP"
pg_restore --no-owner -L "$WORK/acl.list" -f "$WORK/acl.raw.sql" "$DUMP"
node "$HERE/lib/rewrite.mjs" acl "$WORK/acl.raw.sql" "$WORK/acl.sql" "$WORK/acl.json" "$RUNTIME_ROLE"
say "ИНФО $(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const a = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"))
  const dropped = Object.entries(a.grants.droppedByRole).map(([r, n]) => `${r} — ${n}`).join(", ") || "нет"
  console.log(`записей в копии: ${s.entries}; политик перенесено: ${a.policies.kept}, не перенесено: ${a.policies.dropped.length}` +
    ` (${a.policies.dropped.map((p) => `${p.table} для ${p.roles.join("+")}`).join("; ") || "—"})`)
  console.log(`ИНФО выдач прав роли приложения: ${a.grants.toRuntime}; не перенесено выдач: ${dropped}; прав по умолчанию Supabase: ${s.skipped.defaultAcl}`)
' "$WORK/split.json" "$WORK/acl.json")"

# 3. Одна транзакция. OSP_LOAD_TEST_INJECT_FAILURE — только для теста «всё или ничего»: ошибка в конце.
files=(-f "$HERE/compat/auth.sql" -f "$HERE/sql/load-begin.sql" -f "$WORK/main.sql" -f "$WORK/acl.sql" -f "$HERE/sql/load-end.sql")
if [ -n "${OSP_LOAD_TEST_INJECT_FAILURE:-}" ]; then
  echo 'SELECT 1/0;' > "$WORK/fail.sql"
  files+=(-f "$WORK/fail.sql")
fi
started="$(date +%s)"
if ! psql -X -q -v ON_ERROR_STOP=1 -1 \
    -v status="$STATUS" -v source_name="$(basename "$DUMP")" -v source_sha256="$SHA" \
    -v tool_commit="$COMMIT" -v runtime_role="$RUNTIME_ROLE" \
    "${files[@]}" > "$WORK/out" 2> "$WORK/err"; then
  say "FAIL загрузка прервана, транзакция отменена — в базе ничего не изменилось"
  say "ИНФО причина: $(first_error "$WORK/err")"
  save_report
  exit 4
fi
say "OK загружено одной транзакцией за $(( $(date +%s) - started )) с"

# 4. Что получилось — счётчики из самой базы.
summary="$(psql -X -q -At -c "
  select 'ИНФО в базе: таблиц — ' || (select count(*) from pg_tables where schemaname = 'public')
      || ', политик — ' || (select count(*) from pg_policies where schemaname = 'public')
      || ', функций — ' || (select count(*) from osp_meta.manifest where kind = 'function' and schema = 'public')
      || ', представлений — ' || (select count(*) from pg_views where schemaname = 'public')
      || ', материализованных — ' || (select count(*) from pg_matviews where schemaname = 'public')
  union all
  select 'ИНФО отметка: статус ' || status || ', часовой пояс базы — '
      || coalesce((select split_part(c, '=', 2) from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase,
                   unnest(s.setconfig) c where d.datname = current_database() and s.setrole = 0 and c like 'TimeZone=%'), 'не задан')
  from osp_meta.load_log order by 1" 2>"$WORK/err")" || summary="ВНИМАНИЕ итог прочитать не удалось: $(first_error "$WORK/err")"
while IFS= read -r line; do say "$line"; done <<< "$summary"
say "Дальше — сверка: bash migration/target/verify.sh <файл подключения> $DUMP"
save_report
