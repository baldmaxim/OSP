#!/usr/bin/env bash
# Возврат выданной базы к пустой после РЕПЕТИЦИИ — чтобы загрузить копию заново. Запускать на
# удалённой машине из корня репозитория:
#
#   bash migration/target/reset.sh <файл подключения> --yes-drop-rehearsal
#
# Удаляет ровно то, что создал load.sh (перечень — osp_meta.manifest), одной транзакцией.
# Отказывает и ничего не меняет, если:
#   • в базе нет отметки загрузчика — это не наша загрузка;
#   • последняя загрузка — настоящий перенос (final): боевые данные этим скриптом не удаляются никогда;
#   • в базе есть что-то сверх перечня — чужое или созданное после загрузки не удаляем.
# Расширения и схему public не трогает. Данные пользователей не выводит.
# Выход: 0 — база пустая; 1 — ошибка запуска; 2 — нет подключения; 3 — отказ, база не изменена.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"

ENV_FILE="${1:-}"
if [ -z "$ENV_FILE" ] || [ "${2:-}" != "--yes-drop-rehearsal" ] || [ $# -ne 2 ]; then
  echo "Использование: bash migration/target/reset.sh <файл подключения> --yes-drop-rehearsal" >&2
  exit 1
fi
command -v psql >/dev/null || { echo "Нужен psql" >&2; exit 1; }
target_conn "$ENV_FILE" || exit 1
export PGAPPNAME=osp-reset

ERR="$(mktemp)"
cleanup() {
  rm -f -- "$ERR"
  unset PGPASSWORD
}
trap cleanup EXIT

if ! psql -X -q -At -c 'select 1' >/dev/null 2>"$ERR"; then
  echo "FAIL нет подключения: $(head -n 1 "$ERR" | target_mask | cut -c1-200)"
  exit 2
fi

if psql -X -q -v ON_ERROR_STOP=1 -f "$HERE/sql/reset.sql" >/dev/null 2>"$ERR"; then
  echo "OK репетиционная загрузка удалена: база пустая, часовой пояс базы сброшен"
  exit 0
fi
case "$(cat "$ERR")" in
  *OSP_RESET_FINAL*)
    echo "FAIL отказ: в базе настоящий перенос (final) — боевые данные этим скриптом не удаляются" ;;
  *OSP_RESET_NO_MARK*)
    echo "FAIL отказ: в базе нет отметки загрузчика (osp_meta) — это не наша загрузка, ничего не удалено" ;;
  *OSP_RESET_EXTRA*)
    echo "FAIL отказ: в базе есть объекты сверх загруженных ($(grep -oE 'OSP_RESET_EXTRA [0-9]+' "$ERR" | head -n 1 | cut -d' ' -f2)) — чужое не удаляем, ничего не удалено" ;;
  *)
    echo "FAIL очистка прервана, транзакция отменена: $(grep -m 1 -E 'ERROR|FATAL' "$ERR" | sed -E 's/"[^"]*"/"…"/g' | target_mask | cut -c1-200)" ;;
esac
exit 3
