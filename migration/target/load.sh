#!/usr/bin/env bash
# Загрузка проверенной копии прода в выданную базу — ОДНОЙ ТРАНЗАКЦИЕЙ: либо загружено всё, либо
# в базе не изменилось ничего. Запускать на удалённой машине из корня репозитория:
#
#   bash migration/target/load.sh <файл подключения> <копия.dump> --status rehearsal
#   bash migration/target/load.sh <файл подключения> <копия.dump> --status final
#   bash migration/target/load.sh <файл подключения> <копия.dump> --status rehearsal --without-rights
#   bash migration/target/load.sh <файл подключения> <копия.dump> --status final --single-owner
#
# rehearsal — репетиция: загруженное можно убрать (reset.sh). final — настоящий перенос: после него
# reset.sh отказывает всегда.
# --without-rights — без роли приложения: данные и структура загружаются целиком, политики и выдача
# прав — нет, а право «всем» на функции и типы снимается (sql/load-lockdown.sql): обычные учётки
# кластера данные портала не читают и его функции не вызывают. Только для репетиции: настоящий перенос
# в таком виде — отдельным решением.
# --single-owner — то же, что --without-rights, но как первый шаг переноса под одну учётку: после сверки
# (verify.sh) права применяются отдельным шагом rights.sh. В этом виде разрешён и настоящий перенос (final).
#
# Что делает:
#   0. База — та, что закреплена отпечатком (pin.sh): учётка открывает несколько баз кластера.
#   1. Проверки без записи (sql/load-preflight.sql): роль — владелец базы; подключение к базе у «всех»
#      снято; роль приложения есть и не владеет ничем (если права загружаются); расширения включены;
#      база пустая. Любой отказ — загрузка не начинается.
#   2. Копия — только проверенная (рядом лежит отметка .verified от migration/backup/verify.sh).
#   3. Данные, таблицы, функции, индексы — как в копии, без правок. Права и политики — с заменой роли
#      Supabase authenticated на роль приложения; anon и service_role не переносятся (lib/rewrite.mjs).
#   4. Одна транзакция: схема auth (compat/auth.sql), отметка и часовой пояс UTC (sql/load-begin.sql),
#      копия, учётные записи с отпечатками паролей в закрытую схему osp_vault (--auth, sql/load-auth.sql:
#      выгрузки этой же копии, число строк сверяется с описью), адреса сверенных обложек (--covers <журнал>,
#      sql/load-covers.sql — единственная правка данных, объявленная явно), права (sql/load-rights.sql и
#      права из копии) либо закрытие функций (sql/load-lockdown.sql), перечень созданного (sql/load-end.sql).
#   Окончательный перенос (--status final) без --auth и --covers не выполняется: учётки и обложки не могут
#   быть пропущены молча; не сверена хоть одна обложка списка — тоже отказ до записи.
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
  echo "Использование: bash migration/target/load.sh <файл подключения> <копия.dump> --status rehearsal|final [--runtime-role osp_runtime | --without-rights | --single-owner] [--auth] [--covers <журнал.json>]" >&2
  exit 1
}

ENV_FILE="${1:-}"
DUMP="${2:-}"
[ -n "$ENV_FILE" ] && [ -n "$DUMP" ] || usage
shift 2
STATUS=""
RUNTIME_ROLE=""
WITH_RIGHTS=1
SINGLE_OWNER=0
WITH_AUTH=0
COVERS_JOURNAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --status) STATUS="${2:-}"; shift 2 ;;
    --runtime-role) RUNTIME_ROLE="${2:-}"; [ -n "$RUNTIME_ROLE" ] || usage; shift 2 ;;
    --without-rights) WITH_RIGHTS=0; shift ;;
    --single-owner) WITH_RIGHTS=0; SINGLE_OWNER=1; shift ;;
    --auth) WITH_AUTH=1; shift ;;
    --covers) COVERS_JOURNAL="${2:-}"; [ -n "$COVERS_JOURNAL" ] || usage; shift 2 ;;
    *) usage ;;
  esac
done
case "$STATUS" in rehearsal | final) ;; *) usage ;; esac
if [ "$WITH_RIGHTS" = 0 ]; then
  [ -z "$RUNTIME_ROLE" ] || { echo "--without-rights и --runtime-role вместе не задаются: без прав роль приложения не нужна" >&2; exit 1; }
  if [ "$STATUS" = final ] && [ "$SINGLE_OWNER" = 0 ]; then
    echo "Настоящий перенос (final) без прав не выполняется: такая база годится в работу, только когда права проверяет backend, — это отдельное решение" >&2
    exit 1
  fi
  RIGHTS=skipped
else
  RUNTIME_ROLE="${RUNTIME_ROLE:-osp_runtime}"
  [[ "$RUNTIME_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Недопустимое имя роли приложения" >&2; exit 1; }
  RIGHTS=loaded
fi
if [ "$STATUS" = final ] && { [ "$WITH_AUTH" = 0 ] || [ -z "$COVERS_JOURNAL" ]; }; then
  echo "Окончательный перенос (final) — только вместе с учётками и обложками: --auth --covers <журнал covers-copy>" >&2
  exit 1
fi
for bin in psql pg_restore node sha256sum; do
  command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }
done
[ -f "$DUMP" ] || { echo "Нет копии: $DUMP" >&2; exit 1; }
if [ ! -f "${DUMP%.dump}.verified" ]; then
  echo "Копия не проверена восстановлением: сначала bash migration/backup/verify.sh $DUMP" >&2
  exit 1
fi
BASE="${DUMP%.dump}"
if [ "$WITH_AUTH" = 1 ] || [ -n "$COVERS_JOURNAL" ]; then
  # Выгрузки — этой же копии и целы (суммы сняты backup.sh вместе с ними).
  [ -f "$BASE.extras.sha256" ] || { echo "У копии нет выгрузок учёток и обложек (.extras.sha256): копия снята прежним backup.sh" >&2; exit 1; }
  if ! (cd "$(dirname "$DUMP")" && sha256sum --check --quiet --strict "$(basename "$BASE").extras.sha256" >/dev/null 2>&1); then
    echo "Выгрузки копии повреждены: контрольные суммы .extras.sha256 не совпадают" >&2
    exit 1
  fi
fi
if [ -n "$COVERS_JOURNAL" ] && [ ! -f "$COVERS_JOURNAL" ]; then
  echo "Нет журнала копирования обложек: $COVERS_JOURNAL" >&2
  exit 1
fi
inventory_count() { awk -F'\t' -v t="$1" '$1 == t { print $2; f = 1 } END { if (!f) print 0 }' "$BASE.inventory.tsv"; }

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
if [ "$WITH_RIGHTS" = 1 ]; then
  say "ИНФО копия: $(basename "$DUMP"), sha256 ${SHA:0:12}…; роль приложения: $RUNTIME_ROLE"
else
  say "ИНФО копия: $(basename "$DUMP"), sha256 ${SHA:0:12}…; без прав: роли приложения нет"
fi

# 0. Та ли это база.
pin_rc=0
target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) say "OK база — та, что закреплена отпечатком" ;;
  1) say "FAIL база не закреплена: сначала bash migration/target/pin.sh <файл подключения> --confirm"
     say "Загрузка не начата: в базе ничего не изменилось."; save_report; exit 3 ;;
  2) say "FAIL нет подключения: отпечаток базы не прочитан"; save_report; exit 2 ;;
  *) say "FAIL это другая база: отпечаток не совпадает с закреплённым (адрес, база или владелец не те)"
     say "Загрузка не начата: в базе ничего не изменилось."; save_report; exit 3 ;;
esac

# 1. Проверки без записи.
if ! pre="$(psql -X -q -At -v ON_ERROR_STOP=1 -v with_rights="$WITH_RIGHTS" -v runtime_role="$RUNTIME_ROLE" -f "$HERE/sql/load-preflight.sql" 2>"$WORK/err")"; then
  say "FAIL нет подключения или проверки не выполнились: $(first_error "$WORK/err")"
  save_report
  exit 2
fi
failed=0
while IFS= read -r line; do
  case "$line" in
    OK* | ВНИМАНИЕ*) say "$line" ;;
    FAIL*) say "$line"; failed=1 ;;
  esac
done <<< "$pre"
if [ "$failed" = 1 ]; then
  say "Загрузка не начата: в базе ничего не изменилось."
  save_report
  exit 3
fi

# 2. Копия → SQL: основное без правок, права — с заменой ролей (или не загружаются вовсе).
pg_restore --list "$DUMP" > "$WORK/toc"
node "$HERE/lib/rewrite.mjs" split "$WORK/toc" "$WORK/main.list" "$WORK/acl.list" "$WORK/split.json"
pg_restore --no-owner -L "$WORK/main.list" -f "$WORK/main.sql" "$DUMP"
if [ "$WITH_RIGHTS" = 0 ]; then
  say "ИНФО записей в копии: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).entries)' "$WORK/split.json"); политики и выдача прав не загружаются: записей о них в копии — $(grep -c '^[0-9]' "$WORK/acl.list" || true)"
  say "ИНФО право «всем» на функции и типы снимается: обычным учёткам кластера данные и функции портала закрыты"
else
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
fi

# Учётки и обложки: SQL из выгрузок копии и журнала — значения проверены (lib/extras.mjs).
extra_vars=()
if [ "$WITH_AUTH" = 1 ]; then
  if ! node "$HERE/lib/extras.mjs" auth-copy "$BASE.auth-users.csv" "$BASE.auth-identities.csv" > "$WORK/auth-copy.sql" 2> "$WORK/err"; then
    say "FAIL выгрузка учёток не принята: $(first_error "$WORK/err")"
    say "Загрузка не начата: в базе ничего не изменилось."; save_report; exit 3
  fi
  AUTH_USERS="$(inventory_count auth.users)"
  AUTH_IDENTITIES="$(inventory_count auth.identities)"
  extra_vars+=(-v auth_copy_file="$WORK/auth-copy.sql" -v auth_users_expected="$AUTH_USERS" -v auth_identities_expected="$AUTH_IDENTITIES"
    -v auth_users_sha256="$(sha256sum "$BASE.auth-users.csv" | cut -d' ' -f1)"
    -v auth_identities_sha256="$(sha256sum "$BASE.auth-identities.csv" | cut -d' ' -f1)")
  say "ИНФО учётные записи с отпечатками паролей — в закрытую схему osp_vault: учёток $AUTH_USERS, способов входа $AUTH_IDENTITIES"
fi
if [ -n "$COVERS_JOURNAL" ]; then
  if ! node "$HERE/lib/extras.mjs" covers-sql "$COVERS_JOURNAL" "$BASE.covers.csv" "$WORK/covers.json" > "$WORK/covers-data.sql" 2> "$WORK/err"; then
    say "FAIL журнал обложек не принят: $(first_error "$WORK/err")"
    say "Загрузка не начата: в базе ничего не изменилось."; save_report; exit 3
  fi
  read -r COVERS_LISTED COVERS_VERIFIED COVERS_FAILED < <(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(s.listed, s.verified, s.failed)' "$WORK/covers.json")
  if [ "$COVERS_FAILED" != 0 ] && [ "$STATUS" = final ]; then
    say "FAIL обложек не сверено: $COVERS_FAILED из $COVERS_LISTED — окончательный перенос только со всеми: повторить covers-copy"
    say "Загрузка не начата: в базе ничего не изменилось."; save_report; exit 3
  fi
  extra_vars+=(-v covers_data_file="$WORK/covers-data.sql")
  say "ИНФО обложки: в списке копии $COVERS_LISTED, скопировано в cloud.ru и сверено $COVERS_VERIFIED, не сверено $COVERS_FAILED"
fi

# 3. Одна транзакция. OSP_LOAD_TEST_INJECT_FAILURE — только для теста «всё или ничего»: ошибка в конце.
files=(-f "$HERE/compat/auth.sql" -f "$HERE/sql/load-begin.sql" -f "$WORK/main.sql")
if [ "$WITH_AUTH" = 1 ]; then files+=(-f "$HERE/sql/load-auth.sql"); fi
if [ -n "$COVERS_JOURNAL" ]; then files+=(-f "$HERE/sql/load-covers.sql"); fi
if [ "$WITH_RIGHTS" = 1 ]; then
  files+=(-f "$HERE/sql/load-rights.sql" -f "$WORK/acl.sql")
else
  files+=(-f "$HERE/sql/load-lockdown.sql")
fi
files+=(-f "$HERE/sql/load-end.sql")
if [ -n "${OSP_LOAD_TEST_INJECT_FAILURE:-}" ]; then
  echo 'SELECT 1/0;' > "$WORK/fail.sql"
  files+=(-f "$WORK/fail.sql")
fi
started="$(date +%s)"
if ! psql -X -q -v ON_ERROR_STOP=1 -1 \
    -v status="$STATUS" -v source_name="$(basename "$DUMP")" -v source_sha256="$SHA" \
    -v tool_commit="$COMMIT" -v rights="$RIGHTS" -v runtime_role="$RUNTIME_ROLE" "${extra_vars[@]}" \
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
  select 'ИНФО отметка: статус ' || status || ', права — ' || case rights when 'loaded' then 'загружены' else 'не загружались' end || ', часовой пояс базы — '
      || coalesce((select split_part(c, '=', 2) from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase,
                   unnest(s.setconfig) c where d.datname = current_database() and s.setrole = 0 and c like 'TimeZone=%'), 'не задан')
  from osp_meta.load_log order by 1" 2>"$WORK/err")" || summary="ВНИМАНИЕ итог прочитать не удалось: $(first_error "$WORK/err")"
while IFS= read -r line; do say "$line"; done <<< "$summary"
if [ -n "$COVERS_JOURNAL" ]; then
  moved="$(psql -X -q -At -c "select coalesce(sum(objects_updated), 0) || ' (сверенных файлов ' || count(*) || ')' from osp_meta.cover_moves" 2>"$WORK/err")" \
    && say "ИНФО обложки: адресов объектов заменено на /api/covers/… — $moved" \
    || say "ВНИМАНИЕ итог по обложкам прочитать не удалось: $(first_error "$WORK/err")"
fi
say "Дальше — сверка: bash migration/target/verify.sh <файл подключения> $DUMP${COVERS_JOURNAL:+ --covers $COVERS_JOURNAL}"
if [ "$SINGLE_OWNER" = 1 ]; then say "Затем — права под одну учётку: bash migration/target/rights.sh <файл подключения> $DUMP"; fi
save_report
