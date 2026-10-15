#!/usr/bin/env bash
# Соседи по кластеру не пострадали: снимок до работ и сравнение после. ТОЛЬКО ЧТЕНИЕ.
#
#   bash migration/target/neighbors.sh <файл подключения> --save      # снимок: перед любым шагом записи
#   bash migration/target/neighbors.sh <файл подключения> --compare   # сравнить кластер с последним снимком
#
# В кластере рядом лежат базы других систем, а учётка у нас общая. Инструменты переноса работают только с
# закреплённой базой портала (pin.sh), но это требование проверяется и по факту: ни одна соседняя база не
# пропала, не сменила владельца, не уменьшилась; состав учёток прежний; подключений общей учётки хватает
# остальным системам. В чужие базы скрипт не подключается и имён их не показывает.
# Выход: 0 — без замечаний или только «ВНИМАНИЕ»; 1 — ошибка запуска; 2 — нет подключения; 3 — FAIL.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_DIR="${PROBE_REPORT_DIR:-$HERE/reports}"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"
ENV_FILE="${1:-}"; MODE="${2:-}"
case "$MODE" in --save | --compare) ;; *) echo "Использование: bash migration/target/neighbors.sh <файл подключения> --save | --compare" >&2; exit 1 ;; esac
[ -n "$ENV_FILE" ] || { echo "Нужен файл подключения" >&2; exit 1; }
for bin in psql node; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-neighbors
mkdir -p "$REPORT_DIR"; chmod 700 "$REPORT_DIR"
# Снимок для сравнения — под своим именем: с тем же, что у снимка --save той же секунды, он затёр бы точку
# отсчёта (быстрая миграция между --save и --compare) и сравнивать стало бы не с чем.
if [ "$MODE" = --save ]; then
  NOW="$REPORT_DIR/neighbors-$(date -u +%Y%m%d-%H%M%S).tsv"
else
  NOW="$REPORT_DIR/.neighbors-now-$$.tsv"
fi
if ! (umask 077; psql -X -q -At -F $'\t' -f "$HERE/sql/neighbors.sql" > "$NOW" 2>"$NOW.err"); then
  echo "FAIL нет подключения или снимок не снят: $(head -n 1 "$NOW.err" | target_mask | cut -c1-200)"
  rm -f "$NOW" "$NOW.err"; exit 2
fi
rm -f "$NOW.err"
if [ "$MODE" = --save ]; then
  echo "OK снимок кластера сохранён: баз — $(grep -c '^db' "$NOW"), учёток — $(awk -F'\t' '$1 == "roles" { print $2 }' "$NOW")"
  echo "Файл: ${NOW#"$PWD"/} (в нём только отпечатки имён, номера и размеры)"
  exit 0
fi
PREV="$(ls -1 "$REPORT_DIR"/neighbors-*.tsv 2>/dev/null | sort | tail -n 1 || true)"
if [ -z "$PREV" ]; then
  echo "FAIL прежнего снимка нет: сначала --save (до работ)"; rm -f "$NOW"; exit 3
fi
echo "Сравнение кластера со снимком $(basename "$PREV" .tsv | sed 's/neighbors-//') UTC"
rc=0
node "$HERE/lib/neighbors.mjs" "$PREV" "$NOW" || rc=$?
# Текущий снимок при сравнении не сохраняется как точка отсчёта: она задаётся только явным --save.
rm -f "$NOW"
exit "$rc"
