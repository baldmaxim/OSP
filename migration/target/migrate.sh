#!/usr/bin/env bash
# Миграции базы нового портала (база Яндекса под одной учёткой) из migration/yandex/. Из корня репозитория:
#
#   bash migration/target/migrate.sh <файл подключения> --dry-run   # что будет применено (только чтение)
#   bash migration/target/migrate.sh <файл подключения> --yes       # применить новые миграции
#
# На сервере corp — через scripts/deploy-server.sh migrate (в контейнере инструментов, с вопросом перед записью).
#
# Миграции из supabase/migrations сюда не годятся: они написаны под роли Supabase, а в этой базе одна
# учётка и права по правилам sql/load-single-owner.sql. Как писать миграцию — migration/yandex/README.md.
# Что делает --yes:
#   0. База — закреплённая отпечатком (pin.sh), права под одну учётку применены, загрузка завершена.
#   1. Файлы уже применённых миграций не изменены и не удалены (sha256 в osp_meta.schema_migrations);
#      новые применяются по порядку имён. В файле нельзя: BEGIN/COMMIT/ROLLBACK (транзакцию задаёт этот
#      скрипт), команды psql (\…), CONCURRENTLY, роли Supabase (TO / FROM anon, authenticated, service_role).
#   2. До первой записи — снимок соседей по кластеру (neighbors.sh --save) и копия базы (export.sh). Не
#      удалось — отказ, база не тронута.
#   3. Каждая миграция — одна транзакция: предел ожидания блокировки 10 с, отметка служебной операции.
#      В той же транзакции, до COMMIT: проверка прав под одну учётку (sql/rights-check-body.sql — та же,
#      что у rights.sh --check), проверка самой миграции (<имя>.check.sql, строки «OK …» / «FAIL …») и
#      запись в osp_meta.schema_migrations. Хоть один FAIL или ошибка — откат, следующие не применяются.
#      Созданные миграцией таблицы, последовательности и функции дописываются в перечень загрузки
#      (osp_meta.manifest) — по нему reset.sh убирает репетицию целиком.
#   4. Сравнение соседей с первым снимком (neighbors.sh --compare).
# В вывод и отчёт (<PROBE_REPORT_DIR или migration/target/reports>/migrate-<время>.txt) — только имена
# миграций, строки проверок и числа. Выход: 0 — применено или нечего; 1 — ошибка запуска; 2 — нет
# подключения; 3 — отказ до записи; 4 — миграция отменена (откат), более ранние из этого запуска остались.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
MIG_DIR="${OSP_MIGRATIONS_DIR:-$ROOT/migration/yandex}"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"

usage() { echo "Использование: bash migration/target/migrate.sh <файл подключения> --dry-run | --yes" >&2; exit 1; }
ENV_FILE="${1:-}"
MODE="${2:-}"
[ -n "$ENV_FILE" ] && [ $# -eq 2 ] || usage
case "$MODE" in --dry-run | --yes) ;; *) usage ;; esac
for bin in psql sha256sum; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
[ -d "$MIG_DIR" ] || { echo "Нет каталога миграций: $MIG_DIR" >&2; exit 1; }
# Пути передаются командам psql \i / \o без кавычек — без пробелов.
case "$MIG_DIR$HERE" in *[[:space:]]*) echo "Путь к миграциям или к скрипту содержит пробел: psql его не примет" >&2; exit 1 ;; esac
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-migrate
TOOL_COMMIT="${OSP_TOOL_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"

WORK="$(mktemp -d)"; chmod 700 "$WORK"
REPORT=""
trap 'rm -rf -- "$WORK"; unset PGPASSWORD' EXIT
say() { REPORT+="$1"$'\n'; printf '%s\n' "$1"; }
save_report() {
  mkdir -p "$REPORT_DIR"; chmod 700 "$REPORT_DIR"
  local file="$REPORT_DIR/migrate-$(date -u +%Y%m%d-%H%M%S).txt"
  (umask 077; printf '%s' "$REPORT" > "$file")
  echo "Отчёт сохранён: ${file#"$PWD"/}"
}
stop() { say "$2"; save_report; exit "$1"; }
first_error() {
  grep -m 1 -E 'ERROR:|FATAL:|error:' "$1" | sed -E 's/^.*(ERROR|FATAL|error): */\1: /; s/\([^)]*\)/(…)/g' | target_mask | cut -c1-240
}

say "Миграции базы нового портала ($MODE). $(date -u '+%Y-%m-%d %H:%M') UTC"
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
[ "$RIGHTS" = single ] && [ "$FINISHED" = t ] || stop 3 "FAIL права под одну учётку не применены или загрузка не завершена (отметка: $RIGHTS) — миграции не к месту"

# 1. Что уже применено и что нового.
mapfile -t FILES < <(find "$MIG_DIR" -maxdepth 1 -type f -name '*.sql' ! -name '*.check.sql' -printf '%f\n' | LC_ALL=C sort)
for f in "${FILES[@]}"; do
  [[ "$f" =~ ^[0-9]{8}_[a-z0-9_]+\.sql$ ]] || stop 3 "FAIL имя миграции не по образцу ГГГГММДД_имя.sql: $f"
done
APPLIED=""
if [ "$(psql -X -q -At -c "select to_regclass('osp_meta.schema_migrations') is not null" 2>"$WORK/err")" = t ]; then
  APPLIED="$(psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "select name, sha256 from osp_meta.schema_migrations order by name" 2>"$WORK/err")" \
    || stop 2 "FAIL журнал миграций не прочитан: $(first_error "$WORK/err")"
fi
declare -A DONE=()
while IFS=$'\t' read -r name sha; do
  [ -n "$name" ] || continue
  DONE[$name]=1
  [ -f "$MIG_DIR/$name.sql" ] || stop 3 "FAIL файла применённой миграции нет: $name.sql — историю миграций не удаляют"
  [ "$(sha256sum "$MIG_DIR/$name.sql" | cut -d' ' -f1)" = "$sha" ] \
    || stop 3 "FAIL файл применённой миграции изменён: $name.sql — исправление пишется новой миграцией"
done <<< "$APPLIED"
PENDING=()
for f in "${FILES[@]}"; do
  [ -n "${DONE[${f%.sql}]:-}" ] || PENDING+=("$f")
done
say "OK применено раньше: ${#DONE[@]}; новых: ${#PENDING[@]}"
if [ "${#PENDING[@]}" -eq 0 ]; then
  say "ИТОГ: новых миграций нет — база не менялась."
  save_report; exit 0
fi

# Запреты — по тексту без комментариев «--».
for f in "${PENDING[@]}"; do
  code="$(sed -E 's/--.*$//' "$MIG_DIR/$f")"
  if grep -q -i -E '^[[:space:]]*(begin|commit|rollback|start[[:space:]]+transaction|savepoint)[[:space:]]*(transaction|work)?[[:space:]]*;' <<< "$code"; then
    stop 3 "FAIL $f: BEGIN/COMMIT/ROLLBACK в файле нельзя — транзакцию задаёт migrate.sh"
  fi
  grep -q -E '^[[:space:]]*\\' <<< "$code" && stop 3 "FAIL $f: команды psql (\\…) в миграции нельзя — только SQL"
  grep -q -i 'concurrently' <<< "$code" && stop 3 "FAIL $f: CONCURRENTLY в транзакции не работает — индекс без CONCURRENTLY или отдельной задачей"
  if grep -q -i -E '\b(to|from)[[:space:]]+(public[[:space:]]*,[[:space:]]*)?(anon|authenticated|service_role)\b' <<< "$code"; then
    stop 3 "FAIL $f: ролей Supabase (anon, authenticated, service_role) в этой базе нет — права по образцам migration/yandex/README.md"
  fi
done
for f in "${PENDING[@]}"; do
  check="$MIG_DIR/${f%.sql}.check.sql"
  say "ИНФО к применению: ${f%.sql}$([ -f "$check" ] && echo ' (с проверкой)')"
done
if [ "$MODE" = --dry-run ]; then
  say "ИТОГ: к применению ${#PENDING[@]} — запуск с --yes применит их по порядку."
  save_report; exit 0
fi

# 2. До первой записи: снимок соседей и копия базы.
if ! out="$(bash "$HERE/neighbors.sh" "$ENV_FILE" --save 2>&1)"; then
  say "$out"; stop 3 "FAIL снимок соседей не снят — миграции не применяются"
fi
say "OK снимок соседей по кластеру снят"
if ! out="$(bash "$HERE/export.sh" "$ENV_FILE" 2>&1)"; then
  say "$(printf '%s\n' "$out" | grep -E '^(FAIL|OK)' | head -n 3)"
  stop 3 "FAIL копия базы перед миграцией не снята — миграции не применяются"
fi
say "OK копия базы перед миграцией: $(printf '%s\n' "$out" | grep -m 1 -E '^Каталог:' | sed 's/^Каталог: //')"

if ! psql -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS osp_meta.schema_migrations (
    name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), tool_commit text NOT NULL)" 2>"$WORK/err"; then
  stop 4 "FAIL журнал миграций не создан: $(first_error "$WORK/err")"
fi

# 3. По одной транзакции на миграцию; решение COMMIT / ROLLBACK — по строкам проверок в той же транзакции.
cat > "$WORK/apply.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';
SET LOCAL application_name = 'osp:internal';
\i :mig_file
-- Проверки — в той же транзакции. Права — без пропуска (тело само снимает отметку на «живую» часть).
\o :checks_file
\i :rights_check
SET LOCAL application_name = 'osp:internal';
\if :has_check
\i :check_file
\endif
\o
\set osp_fails `grep -c '^FAIL' "$OSP_CHECKS_FILE" || true`
\set osp_oks `grep -c '^OK' "$OSP_CHECKS_FILE" || true`
SELECT (:osp_fails = 0 AND :osp_oks > 0) AS osp_commit \gset
\if :osp_commit
-- Созданное миграцией — в перечень загрузки (как load-end.sql): иначе reset.sh примет новые таблицы,
-- последовательности и функции за чужие и откажет. search_path пустой — так перечень и сверяется.
SELECT pg_catalog.set_config('search_path', '', true);
INSERT INTO osp_meta.manifest (kind, schema, name, detail)
SELECT 'relation', n.nspname::text, c.relname::text, c.relkind::text
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'c')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')
UNION
SELECT 'function', n.nspname::text, p.proname::text, pg_catalog.pg_get_function_identity_arguments(p.oid)
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e')
UNION
SELECT 'type', n.nspname::text, t.typname::text, t.typtype::text
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname IN ('public', 'auth') AND t.typtype IN ('e', 'd', 'r')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND d.objid = t.oid AND d.deptype = 'e')
EXCEPT
SELECT kind, schema, name, detail FROM osp_meta.manifest;
INSERT INTO osp_meta.schema_migrations (name, sha256, tool_commit) VALUES (:'mig_name', :'mig_sha', :'tool_commit');
COMMIT;
\echo OSP_MIGRATE_COMMITTED
\else
ROLLBACK;
\echo OSP_MIGRATE_REJECTED
\endif
SQL

applied=0
for f in "${PENDING[@]}"; do
  name="${f%.sql}"
  check="$MIG_DIR/$name.check.sql"
  checks_out="$WORK/checks-$name.txt"
  : > "$checks_out"
  started="$(date +%s)"
  rc=0
  OSP_CHECKS_FILE="$checks_out" psql -X -q -At -v ON_ERROR_STOP=1 \
    -v mig_file="$MIG_DIR/$f" -v rights_check="$HERE/sql/rights-check-body.sql" \
    -v check_file="$check" -v has_check="$([ -f "$check" ] && echo true || echo false)" \
    -v checks_file="$checks_out" -v mig_name="$name" -v mig_sha="$(sha256sum "$MIG_DIR/$f" | cut -d' ' -f1)" \
    -v tool_commit="$TOOL_COMMIT" -f "$WORK/apply.sql" > "$WORK/out" 2> "$WORK/err" || rc=$?
  while IFS= read -r line; do
    case "$line" in FAIL*) say "  $line" ;; esac
  done < "$checks_out"
  if [ "$rc" != 0 ]; then
    say "FAIL $name: ошибка — транзакция отменена, миграция не применена: $(first_error "$WORK/err")"
    stop 4 "ИТОГ: применено в этом запуске: $applied; остальные не начинались. Копия базы — выше."
  fi
  if ! grep -q '^OSP_MIGRATE_COMMITTED$' "$WORK/out"; then
    say "FAIL $name: проверки не пройдены — транзакция отменена, миграция не применена"
    stop 4 "ИТОГ: применено в этом запуске: $applied; остальные не начинались."
  fi
  applied=$((applied + 1))
  say "OK $name: применена за $(( $(date +%s) - started )) с; проверок OK — $(grep -c '^OK' "$checks_out")"
done

# 4. Соседи.
if ! out="$(bash "$HERE/neighbors.sh" "$ENV_FILE" --compare 2>&1)"; then
  say "$out"
  stop 3 "ИТОГ: миграции применены ($applied), но сравнение соседей дало замечания — разобраться до любых дальнейших шагов."
fi
say "OK соседи по кластеру не изменились"
say "ИТОГ: применено миграций: $applied. Дальше — PostgREST перечитывает структуру (SIGUSR1); scripts/deploy-server.sh migrate делает это сам."
save_report
