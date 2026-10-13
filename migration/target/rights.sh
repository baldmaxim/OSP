#!/usr/bin/env bash
# Права под одну учётку — отдельный шаг после загрузки и сверки (одной транзакцией):
#
#   bash migration/target/load.sh   <файл подключения> <копия.dump> --status rehearsal|final --single-owner
#   bash migration/target/verify.sh <файл подключения> <копия.dump>     # данные и структура — как в копии
#   bash migration/target/rights.sh <файл подключения> <копия.dump>     # политики и права под одну учётку
#   bash migration/target/rights.sh <файл подключения> --check          # только проверка, без записи
#
# Зачем отдельно: сверка сравнивает базу с копией «как есть», а этот шаг намеренно меняет структуру
# (правила действуют на владельца, служебные функции получают пропуск, материализованные представления
# уходят в закрытую схему). Данные он не трогает: число строк до и после сверяется в той же транзакции.
# Что именно делается и почему — sql/load-single-owner.sql.
# Выход: 0 — права применены и проверены; 1 — ошибка запуска; 2 — нет подключения; 3 — проверки не
#        пройдены или шаг не к месту; 4 — применение прервано, транзакция отменена.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"

usage() { echo "Использование: bash migration/target/rights.sh <файл подключения> <копия.dump> | --check" >&2; exit 1; }
ENV_FILE="${1:-}"
ARG="${2:-}"
[ -n "$ENV_FILE" ] && [ -n "$ARG" ] && [ $# -eq 2 ] || usage
for bin in psql pg_restore node sha256sum; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
target_conn "$ENV_FILE" || exit 1

WORK="$(mktemp -d)"; chmod 700 "$WORK"
REPORT=""
trap 'rm -rf -- "$WORK"; unset PGPASSWORD' EXIT
say() { REPORT+="$1"$'\n'; printf '%s\n' "$1"; }
save_report() {
  mkdir -p "$REPORT_DIR"; chmod 700 "$REPORT_DIR"
  local file="$REPORT_DIR/rights-$(date -u +%Y%m%d-%H%M%S).txt"
  (umask 077; printf '%s' "$REPORT" > "$file")
  echo "Отчёт сохранён: ${file#"$PWD"/}"
}
first_error() {
  grep -m 1 -E 'ERROR:|FATAL:|error:' "$1" | sed -E 's/^.*(ERROR|FATAL|error): */\1: /; s/\([^)]*\)/(…)/g' | target_mask | cut -c1-240
}
check() {
  local out failed=0 line
  # Проверка идёт без отметки пропуска: видит базу так же, как запрос мимо шлюза.
  if ! out="$(PGAPPNAME=osp-rights-check psql -X -q -At -v ON_ERROR_STOP=1 -f "$HERE/sql/rights-check.sql" 2>"$WORK/err")"; then
    say "FAIL проверка прав не выполнилась: $(first_error "$WORK/err")"; return 1
  fi
  while IFS= read -r line; do
    case "$line" in OK*) say "$line" ;; FAIL*) say "$line"; failed=1 ;; esac
  done <<< "$out"
  return "$failed"
}

say "Права под одну учётку. $(date -u '+%Y-%m-%d %H:%M') UTC"
pin_rc=0; target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) say "OK база — та, что закреплена отпечатком" ;;
  2) say "FAIL нет подключения: отпечаток базы не прочитан"; save_report; exit 2 ;;
  *) say "FAIL база не закреплена или это другая база — ничего не изменено"; save_report; exit 3 ;;
esac
if ! mark="$(psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "select status, source_sha256, rights, (finished_at is not null) from osp_meta.load_log order by id desc limit 1" 2>"$WORK/err")"; then
  say "FAIL в базе нет отметки загрузки: сначала load.sh … --single-owner"; save_report; exit 3
fi
IFS=$'\t' read -r STATUS LOADED_SHA RIGHTS FINISHED <<< "$mark"

if [ "$ARG" = --check ]; then
  [ "$RIGHTS" = single ] || { say "FAIL права под одну учётку ещё не применены (отметка: $RIGHTS)"; save_report; exit 3; }
  if check; then say "ИТОГ: права в порядке."; save_report; exit 0; fi
  say "ИТОГ: ЕСТЬ ЗАМЕЧАНИЯ. Базу в работу не пускать."; save_report; exit 3
fi

DUMP="$ARG"
[ -f "$DUMP" ] || { echo "Нет копии: $DUMP" >&2; exit 1; }
SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
if [ "$LOADED_SHA" != "$SHA" ] || [ "$FINISHED" != t ]; then
  say "FAIL в базу загружена другая копия или загрузка не завершена — права не применяются"; save_report; exit 3
fi
if [ "$RIGHTS" != skipped ]; then
  say "FAIL шаг не к месту: отметка прав — $RIGHTS (нужна загрузка load.sh … --single-owner, ещё без прав)"; save_report; exit 3
fi
say "ИНФО отметка загрузки: статус $STATUS, копия та же (sha256 ${SHA:0:12}…)"

pg_restore --list "$DUMP" > "$WORK/toc"
node "$HERE/lib/rewrite.mjs" split "$WORK/toc" "$WORK/main.list" "$WORK/acl.list" "$WORK/split.json"
pg_restore --no-owner -L "$WORK/acl.list" -f "$WORK/acl.raw.sql" "$DUMP"
node "$HERE/lib/rewrite.mjs" acl-single-owner "$WORK/acl.raw.sql" "$WORK/acl.sql" "$WORK/acl.json"
say "ИНФО $(node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const roles = Object.entries(a.policies.byRole).map(([r, n]) => `${r} — ${n}`).join(", ")
  console.log(`политик в копии: ${a.policies.kept} (${roles}); выдача прав не переносится — её заменяет список шлюза`)
' "$WORK/acl.json")"

# Число строк до и после — в той же транзакции: шаг меняет только структуру.
cat > "$WORK/rows.sql" <<'SQL'
CREATE TEMP TABLE osp_rows_STAGE ON COMMIT DROP AS
SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint AS n
FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition;
SQL
sed 's/STAGE/before/' "$WORK/rows.sql" > "$WORK/rows-before.sql"
{
  sed 's/STAGE/after/' "$WORK/rows.sql"
  cat <<'SQL'
DO $$
DECLARE v_diff bigint;
BEGIN
  SELECT count(*) INTO v_diff FROM osp_rows_before b FULL JOIN osp_rows_after a USING (relname) WHERE b.n IS DISTINCT FROM a.n;
  IF v_diff > 0 THEN RAISE EXCEPTION 'число строк изменилось в таблицах: %', v_diff; END IF;
END $$;
SQL
} > "$WORK/rows-after.sql"

started="$(date +%s)"
# Отметка пропуска — командой внутри транзакции: после включения правил владелец без неё не видит ни
# строки. Задать её именем подключения (PGAPPNAME) нельзя: пулер Яндекса дописывает к имени адрес клиента,
# и отметка не совпадает. Заодно это значит, что параметрами подключения пропуск получить невозможно.
echo "SET LOCAL application_name = 'osp:internal';" > "$WORK/mark.sql"
if ! PGAPPNAME=osp-rights psql -X -q -v ON_ERROR_STOP=1 -1 \
    -f "$WORK/mark.sql" -f "$WORK/rows-before.sql" -f "$WORK/acl.sql" -f "$HERE/sql/load-single-owner.sql" -f "$WORK/rows-after.sql" -f "$HERE/sql/rights-end.sql" \
    > "$WORK/out" 2> "$WORK/err"; then
  say "FAIL применение прервано, транзакция отменена — в базе ничего не изменилось"
  say "ИНФО причина: $(first_error "$WORK/err")"
  save_report; exit 4
fi
say "OK права применены одной транзакцией за $(( $(date +%s) - started )) с; число строк в таблицах не изменилось"
if check; then
  say "ИТОГ: права под одну учётку применены и проверены."
  save_report; exit 0
fi
say "ИТОГ: ЕСТЬ ЗАМЕЧАНИЯ. Базу в работу не пускать."
save_report; exit 3
