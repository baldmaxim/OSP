#!/usr/bin/env bash
# Прогон миграции на копии прода — до того, как её применят на проде. Прод не трогает.
#
#   bash migration/backup/rehearse.sh <копия.dump> <миграция.sql> [проверка.sql]
#
# Порядок: копия → подсчёт строк → миграция → та же миграция ещё раз (повтор должен
# быть безопасен) → подсчёт строк → проверочный запрос (если задан). Перед миграцией
# включаются права по умолчанию, как в Supabase (supabase-defaults.sql).
# Годно, если оба прогона прошли без ошибок и ни в одной прежней таблице не
# изменилось число строк. Новые таблицы перечисляются отдельно.
# В вывод — только имена таблиц, числа и заголовки ошибок. Выход 0 — годно.
set -euo pipefail

DUMP="${1:?укажите файл копии}"
MIGRATION="${2:?укажите файл миграции}"
CHECK="${3:-}"
BASE="${DUMP%.dump}"
source "$(dirname "$0")/lib.sh"

[ -f "$DUMP" ] || { echo "Нет файла $DUMP"; exit 1; }
[ -f "$MIGRATION" ] || { echo "Нет файла $MIGRATION"; exit 1; }
if [ ! -f "$BASE.verified" ]; then
  echo "Копия ещё не проверена восстановлением — сначала verify.sh $DUMP"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'pg_stop; rm -rf "$TMP"' EXIT

echo "Временный PostgreSQL ($PG_IMAGE), восстановление копии…"
pg_start
restore_dump "$DUMP" "$TMP/restore.log"
if [ "$RESTORE_ERRORS" != "0" ]; then
  echo "Копия восстановилась с ошибками ($RESTORE_ERRORS) — прогон не имеет смысла:"
  print_errors "$TMP/restore.log"
  exit 1
fi
local_counts "$TMP/before.tsv"
local_psql -f "$(dirname "$0")/supabase-defaults.sql" >/dev/null

OK=1
for run in 1 2; do
  if local_psql -f "$MIGRATION" >"$TMP/run$run.log" 2>&1; then
    echo "Прогон $run: миграция прошла"
  else
    OK=0
    echo "Прогон $run: ОШИБКА"
    grep -E '^psql:.*ERROR' "$TMP/run$run.log" | sed -E 's/(DETAIL|Key \(|CONTEXT|LINE [0-9]+).*$//' | cut -c1-200 | head -10
    break
  fi
done
local_counts "$TMP/after.tsv"

REPORT="$(awk -F'\t' '
  FILENAME == ARGV[1] { before[$1] = $2; next }
  { after[$1] = $2; if (!($1 in before)) added[++m] = $1 }
  END {
    bad = 0
    for (t in before) {
      if (!(t in after)) { printf "%-45s %12s %12s  ТАБЛИЦА ИСЧЕЗЛА\n", t, before[t], "-"; bad++ }
      else if (before[t] != after[t]) { printf "%-45s %12s %12s  ЧИСЛО СТРОК ИЗМЕНИЛОСЬ\n", t, before[t], after[t]; bad++ }
    }
    for (i = 1; i <= m; i++) printf "%-45s %12s %12s  новая таблица\n", added[i], "-", after[added[i]]
    printf "BAD=%d\nTABLES=%d\n", bad, length(before)
  }' "$TMP/before.tsv" "$TMP/after.tsv")"
echo "$REPORT" | grep -vE '^(BAD|TABLES)=' || true
BAD="$(echo "$REPORT" | sed -n 's/^BAD=//p')"
TABLES="$(echo "$REPORT" | sed -n 's/^TABLES=//p')"
[ "$BAD" = "0" ] || OK=0

# Проверочный запрос печатает строки «OK …» или «FAIL …». Годно — только если нет ни
# одной FAIL и есть хотя бы одна OK.
if [ -n "$CHECK" ]; then
  echo
  echo "Проверочный запрос:"
  if local_psql -At -f "$CHECK" >"$TMP/check.out" 2>&1; then
    cat "$TMP/check.out"
    grep -q '^FAIL' "$TMP/check.out" && OK=0
    grep -q '^OK' "$TMP/check.out" || OK=0
  else
    OK=0
    grep -E 'ERROR' "$TMP/check.out" | cut -c1-200 | head -5
  fi
fi

echo
if [ "$OK" = "1" ]; then
  echo "МИГРАЦИЯ ГОДНА: два прогона без ошибок, число строк во всех $TABLES прежних таблицах не изменилось."
  exit 0
fi
echo "МИГРАЦИЯ НЕ ГОДНА: на прод не применять."
exit 1
