#!/usr/bin/env bash
# Проверка копии восстановлением. Прод не трогает: копия поднимается во временном
# PostgreSQL в Docker, после проверки контейнер удаляется вместе с данными.
#
#   bash migration/backup/verify.sh migration/dumps/prod-<время>.dump
#
# Копия годна, если:
#   • контрольная сумма совпадает с записанной при снятии;
#   • восстановление прошло без ошибок;
#   • в каждой таблице столько же строк, сколько было на проде до или после копии
#     (если таблица менялась во время копии — число между этими значениями).
# В вывод — только имена таблиц и числа. Выход 0 — копия годна, 1 — нет.
set -euo pipefail

DUMP="${1:?укажите файл копии: migration/dumps/prod-<время>.dump}"
BASE="${DUMP%.dump}"
source "$(dirname "$0")/lib.sh"

[ -f "$DUMP" ] || { echo "Нет файла $DUMP"; exit 1; }
for f in "$BASE.counts-before.tsv" "$BASE.counts-after.tsv"; do
  [ -f "$f" ] || { echo "Нет $f — копия снята не через backup.sh?"; exit 1; }
done

# Сравниваем само значение суммы: путь в .sha256 зависит от того, откуда запускали
# backup.sh, и для проверки не важен.
if [ -f "$DUMP.sha256" ]; then
  EXPECTED="$(awk 'NR == 1 { print $1 }' "$DUMP.sha256")"
  ACTUAL="$(sha256sum "$DUMP" | awk '{ print $1 }')"
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "КОПИЯ ПОВРЕЖДЕНА: контрольная сумма не совпадает"; exit 1
  fi
fi

TMP="$(mktemp -d)"
trap 'pg_stop; rm -rf "$TMP"' EXIT

echo "Временный PostgreSQL ($PG_IMAGE)…"
pg_start
echo "Восстановление копии…"
restore_dump "$DUMP" "$BASE.restore.log"
local_counts "$TMP/restored.tsv"

OK=1
if [ "$RESTORE_ERRORS" != "0" ]; then
  OK=0
  echo
  echo "Ошибок восстановления: $RESTORE_ERRORS (заголовки, без данных):"
  print_errors "$BASE.restore.log"
fi

echo
printf '%-45s %12s %12s %12s  %s\n' 'таблица' 'до копии' 'после' 'в копии' 'итог'
REPORT="$(awk -F'\t' '
  FILENAME == ARGV[1] { before[$1] = $2; order[++n] = $1; next }
  FILENAME == ARGV[2] { after[$1] = $2; next }
  { restored[$1] = $2 }
  END {
    bad = 0
    for (i = 1; i <= n; i++) {
      t = order[i]; b = before[t] + 0; a = (t in after) ? after[t] + 0 : b
      if (!(t in restored)) { st = "НЕТ ТАБЛИЦЫ"; bad++; r = "-" }
      else {
        r = restored[t] + 0
        lo = (b < a) ? b : a; hi = (b < a) ? a : b
        if (r == b || r == a) st = (b == a) ? "ок" : "ок (менялась во время копии)"
        else if (r >= lo && r <= hi) st = "ок (менялась во время копии)"
        else { st = "РАСХОЖДЕНИЕ"; bad++ }
      }
      printf "%-45s %12s %12s %12s  %s\n", t, b, a, r, st
    }
    printf "BAD=%d\n", bad
  }' "$BASE.counts-before.tsv" "$BASE.counts-after.tsv" "$TMP/restored.tsv")"
echo "$REPORT" | grep -v '^BAD=' || true
BAD="$(echo "$REPORT" | sed -n 's/^BAD=//p')"
[ "$BAD" = "0" ] || OK=0

TOTAL="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$TMP/restored.tsv")"
echo
if [ "$OK" = "1" ]; then
  echo "КОПИЯ ГОДНА: таблиц $(wc -l <"$TMP/restored.tsv"), строк $TOTAL, ошибок восстановления нет."
  touch "$BASE.verified"
  chmod 600 "$BASE.verified"
  exit 0
fi
echo "КОПИЯ НЕ ПРОВЕРЕНА: см. выше. Миграции до исправления не применять."
exit 1
