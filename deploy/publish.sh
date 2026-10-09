#!/usr/bin/env bash
# Выкладка готовой сборки (dist) в каталоги-релизы. Вызывается из deploy.sh;
# отдельно — для проверки (tests/deploy). Выполнять от danila, без sudo.
#
#   bash deploy/publish.sh <каталог dist> <WEB_ROOT>
#
# Раскладка WEB_ROOT (/var/www/osp):
#   releases/<buildId>/  — сборка целиком, по каталогу на релиз (KEEP_RELEASES последних)
#   assets/              — общий каталог хэш-файлов недавних сборок: вкладка, открытая
#                          до деплоя, догружает чанки своей сборки (раньше rsync --delete
#                          их удалял — белый экран). Чистятся файлы старше ASSET_TTL_DAYS,
#                          которых нет ни в одном хранимом релизе, — и только когда из
#                          корня убрана прежняя раскладка (п. 5).
#   current -> releases/<buildId>   — то, что отдаёт nginx; переключается атомарно
#   shared/config.json   — runtime-конфиг (необязателен), переживает релизы
#
# Повтор безопасен: та же сборка выкладывается заново, current указывает на неё же.
set -euo pipefail

DIST="${1:?укажите каталог сборки (dist)}"
WEB_ROOT="${2:?укажите WEB_ROOT}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
ASSET_TTL_DAYS="${ASSET_TTL_DAYS:-14}"

test -f "$DIST/index.html" || { echo "В $DIST нет index.html — сборка не готова"; exit 1; }
test -f "$DIST/version.json" || { echo "В $DIST нет version.json"; exit 1; }
[ -w "$WEB_ROOT" ] || { echo "Нет прав на запись в $WEB_ROOT — см. docs/DEPLOYMENT.md, «Каталоги-релизы»"; exit 1; }

BUILD_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).buildId)' "$DIST/version.json")"
[[ "$BUILD_ID" =~ ^[0-9A-Za-z_-]+$ ]] || { echo "Неожиданный buildId: '$BUILD_ID'"; exit 1; }

mkdir -p "$WEB_ROOT/releases" "$WEB_ROOT/assets" "$WEB_ROOT/shared"
# nginx (www-data) только читает: каталоги 755, файлы 644 — при любом umask сборки.
chmod 755 "$WEB_ROOT/releases" "$WEB_ROOT/assets" "$WEB_ROOT/shared"
PERMS='--chmod=D755,F644'

# 1. Хэш-файлы — в общий каталог, ничего не удаляя.
if [ -d "$DIST/assets" ]; then
  rsync -a "$PERMS" "$DIST/assets/" "$WEB_ROOT/assets/"
fi

# 2. Релиз — во временный каталог, затем переименование: недописанный релиз не виден.
STAGE="$WEB_ROOT/releases/.$BUILD_ID.tmp"
rm -rf "$STAGE"
rsync -a "$PERMS" "$DIST/" "$STAGE/"
rm -rf "$WEB_ROOT/releases/$BUILD_ID"
mv -T "$STAGE" "$WEB_ROOT/releases/$BUILD_ID"

# 3. Атомарное переключение: rename(2) символической ссылки поверх старой.
ln -sfn "releases/$BUILD_ID" "$WEB_ROOT/.current.tmp"
mv -T "$WEB_ROOT/.current.tmp" "$WEB_ROOT/current"
echo "Выложен релиз $BUILD_ID"

# 4. Чистка старых релизов (текущий не трогаем никогда).
CURRENT_ID="$(basename "$(readlink "$WEB_ROOT/current")")"
mapfile -t RELEASES < <(find "$WEB_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort -r)
n=0
for r in "${RELEASES[@]}"; do
  n=$((n + 1))
  if [ "$n" -gt "$KEEP_RELEASES" ] && [ "$r" != "$CURRENT_ID" ]; then
    rm -rf "${WEB_ROOT:?}/releases/$r"
  fi
done

# 5. Чистка общих хэш-файлов: старше ASSET_TTL_DAYS и не нужных ни одному хранимому релизу.
#    Пока в корне лежит index.html прежней раскладки (прежний deploy.sh клал сборку прямо в
#    WEB_ROOT), чистки нет: хэш-файлы той сборки ни одному релизу не принадлежат, а время у
#    них — время той сборки. Удалить их — белый экран и у сайта, который nginx до
#    переключения отдаёт из корня, и у вкладок, открытых до перехода. Прежние файлы корня
#    убирают вручную, когда таких вкладок не осталось (docs/DEPLOYMENT.md, «Переход»).
if [ -e "$WEB_ROOT/index.html" ]; then
  echo "В $WEB_ROOT лежит index.html прежней раскладки — чистка общих хэш-файлов отложена"
  exit 0
fi
KEPT="$(mktemp)"
trap 'rm -f "$KEPT"' EXIT
find "$WEB_ROOT/releases" -mindepth 3 -maxdepth 3 -path '*/assets/*' -type f ! -path '*/.*' -printf '%f\n' > "$KEPT"
# Разность списков — awk, без sort/comm: не зависит ни от локали, ни от реализации coreutils
# (comm из uutils 0.8 на сотнях строк из stdin ложно сообщает «not in sorted order»).
find "$WEB_ROOT/assets" -maxdepth 1 -type f -mtime +"$ASSET_TTL_DAYS" -printf '%f\n' |
  awk -v kept="$KEPT" 'BEGIN { while ((getline f < kept) > 0) keep[f] = 1 } !($0 in keep)' |
  while IFS= read -r f; do rm -f "${WEB_ROOT:?}/assets/$f"; done
