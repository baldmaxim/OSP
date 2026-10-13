#!/usr/bin/env bash
# Что видит каждый вид пользователя: число строк каждой таблицы и представления. ТОЛЬКО ЧТЕНИЕ.
#
#   bash migration/target/visibility.sh <файл подключения>                      # замер → файл в reports/
#   bash migration/target/visibility.sh <файл подключения> --compare <замер>    # замер и сравнение с другим
#
# Зачем. Права под одну учётку сверяются с эталоном прода на локальной копии (tests/db/single-owner.test.mjs).
# Этот замер переносит вывод на настоящую базу: стенд и база Яндекса, загруженные из одной копии и
# прошедшие rights.sh, обязаны совпасть по каждому виду пользователя и каждой таблице. Порядок:
#   1) замер на стенде (файл подключения стенда)          → reports/visibility-<время>.txt
#   2) замер в базе Яндекса с --compare <файл из шага 1>  → «совпало» либо перечень отличий
# Виды пользователей: администратор, сотрудник, подрядчик, неодобренный, заблокированный, посторонняя
# учётка, аноним, запрос без данных о пользователе. В файле и выводе — только вид, имя таблицы и число.
#
# Работает только с закреплённой базой (pin.sh): в чужую базу той же учётки не пойдёт.
# Выход: 0 — замер снят / совпало; 1 — ошибка запуска; 2 — нет подключения; 3 — расхождение или база не та.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"
ENV_FILE="${1:-}"; MODE="${2:-}"; OTHER="${3:-}"
usage() { echo "Использование: bash migration/target/visibility.sh <файл подключения> [--compare <замер>]" >&2; exit 1; }
[ -n "$ENV_FILE" ] || usage
case "$MODE" in
  '') ;;
  --compare) [ -n "$OTHER" ] && [ -f "$OTHER" ] || { echo "Нет файла замера для сравнения" >&2; exit 1; } ;;
  *) usage ;;
esac
command -v psql >/dev/null || { echo "Нужен psql" >&2; exit 1; }
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-visibility

pin_rc=0; target_pin_check "$ENV_FILE" || pin_rc=$?
case "$pin_rc" in
  0) ;;
  1) echo "FAIL база не закреплена: сначала bash migration/target/pin.sh <файл подключения> --confirm"; exit 3 ;;
  2) echo "FAIL нет подключения к базе"; exit 2 ;;
  *) echo "FAIL это не закреплённая база портала — замер не снимается"; exit 3 ;;
esac

mkdir -p "$REPORT_DIR"; chmod 700 "$REPORT_DIR"
OUT="$REPORT_DIR/visibility-$(date -u +%Y%m%d-%H%M%S).txt"
# Успех определяется кодом psql (ON_ERROR_STOP) и полнотой замера ниже, а не пустым stderr: туда пишутся
# и безобидные уведомления сервера.
if ! (umask 077; psql -X -q -At -f "$HERE/sql/visibility.sql" 2>"$OUT.err" > "$OUT.raw"); then
  echo "FAIL замер не снят: $(grep -m 1 -E 'ERROR|FATAL|error' "$OUT.err" | target_mask | cut -c1-200)"
  rm -f "$OUT.raw" "$OUT.err"; exit 2
fi
(umask 077; grep -E '^[a-z_]+\|[A-Za-z0-9_]+\|[0-9?]+$' "$OUT.raw" | sort > "$OUT" || true)
rm -f "$OUT.raw" "$OUT.err"
lines="$(wc -l < "$OUT")"
classes="$(cut -d'|' -f1 "$OUT" | sort -u | wc -l)"
relations="$(cut -d'|' -f2 "$OUT" | sort -u | wc -l)"
if [ "$lines" -eq 0 ] || [ "$lines" -ne $((classes * relations)) ]; then
  echo "FAIL замер неполный: строк $lines, видов пользователей $classes, таблиц и представлений $relations"
  rm -f "$OUT"; exit 2
fi
echo "OK замер снят: видов пользователей — $classes, таблиц и представлений — $relations, замеров — $lines"
echo "Файл: ${OUT#"$PWD"/} (в нём только вид пользователя, имя таблицы и число строк)"
[ "$MODE" = --compare ] || exit 0

other_sorted="$(mktemp)"; trap 'rm -f "$other_sorted"' EXIT
sort "$OTHER" > "$other_sorted"
other_lines="$(wc -l < "$other_sorted")"
differ="$(diff "$other_sorted" "$OUT" | grep -c '^[<>]' || true)"
if [ "$differ" -eq 0 ] && [ "$other_lines" -eq "$lines" ]; then
  echo "OK совпало с $(basename "$OTHER"): $lines замеров из $lines — каждый вид пользователя видит то же самое"
  exit 0
fi
echo "FAIL отличия от $(basename "$OTHER") («<» — там, «>» — здесь), первые 20:"
diff "$other_sorted" "$OUT" | grep '^[<>]' | head -n 20
echo "Всего отличающихся строк: $differ; замеров там — $other_lines, здесь — $lines"
exit 3
