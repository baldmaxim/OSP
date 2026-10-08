#!/usr/bin/env bash
# Откат фронта на предыдущий релиз — выполнять от danila, без sudo:
#
#   bash deploy/rollback.sh             — на предыдущий по времени релиз
#   bash deploy/rollback.sh <buildId>   — на указанный (каталог /var/www/osp/releases/<buildId>)
#
# Граница отката: если текущий релиз объявил rollbackFloor (release.json) выше
# уровня совместимости цели, откат запрещён — после такого релиза сервер уже
# убрал то, чем пользовалась старая сборка. Повтор безопасен.
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/var/www/osp}"
[ -L "$WEB_ROOT/current" ] || { echo "Нет $WEB_ROOT/current — откатывать нечего"; exit 1; }

CURRENT_ID="$(basename "$(readlink "$WEB_ROOT/current")")"
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$(find "$WEB_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort -r |
    awk -v cur="$CURRENT_ID" '$0 < cur { print; exit }')"
fi
[[ "$TARGET" =~ ^[0-9A-Za-z_-]+$ ]] && [ -d "$WEB_ROOT/releases/$TARGET" ] || {
  echo "Релиз для отката не найден${TARGET:+: $TARGET}"; exit 1; }
[ "$TARGET" != "$CURRENT_ID" ] || { echo "Уже на релизе $TARGET"; exit 0; }

field() {
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Number(v[process.argv[2]]) || 0) } catch { console.log(0) }' "$1" "$2"
}
FLOOR="$(field "$WEB_ROOT/releases/$CURRENT_ID/version.json" rollbackFloor)"
TARGET_COMPAT="$(field "$WEB_ROOT/releases/$TARGET/version.json" compat)"
if [ "$TARGET_COMPAT" -lt "$FLOOR" ]; then
  echo "Откат на $TARGET запрещён: его уровень совместимости $TARGET_COMPAT ниже границы отката $FLOOR текущего релиза $CURRENT_ID."
  echo "Исправление — новым релизом вперёд."
  exit 1
fi

# Файлы цели могли быть вычищены из общего каталога — возвращаем.
if [ -d "$WEB_ROOT/releases/$TARGET/assets" ]; then
  rsync -a "$WEB_ROOT/releases/$TARGET/assets/" "$WEB_ROOT/assets/"
fi
ln -sfn "releases/$TARGET" "$WEB_ROOT/.current.tmp"
mv -T "$WEB_ROOT/.current.tmp" "$WEB_ROOT/current"
echo "Откат выполнен: current -> releases/$TARGET (было $CURRENT_ID)"
