#!/usr/bin/env bash
# Запуск контейнера сайта: выложить сборку из образа в том и запустить nginx.
#
# Том /var/www/osp переживает смену образа: в нём каталоги-релизы и общий каталог хэш-файлов недавних
# сборок (deploy/publish.sh) — вкладка, открытая до выкладки, догружает файлы своей сборки. Повторный
# запуск того же образа ничего не меняет: та же сборка выкладывается заново.
#
# Возврат сайта — запуск прежнего образа (deploy/docker/deploy.sh --rollback). Граница отката та же, что
# у deploy/rollback.sh: если работающий релиз объявил rollbackFloor выше уровня совместимости сборки из
# образа, сборка не выкладывается — nginx продолжает отдавать работающий релиз, а в журнале остаётся
# причина. Сервер в этом случае уже убрал то, чем пользовалась старая сборка; исправление — новым образом.
set -euo pipefail
WEB_ROOT=/var/www/osp
DIST=/opt/osp/dist

field() { # field <version.json> <поле> — число, 0 при любой ошибке
  node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Number(v[process.argv[2]]) || 0) } catch { console.log(0) }' "$1" "$2"
}

publish=1
if [ -L "$WEB_ROOT/current" ] && [ -f "$WEB_ROOT/current/version.json" ]; then
  floor="$(field "$WEB_ROOT/current/version.json" rollbackFloor)"
  compat="$(field "$DIST/version.json" compat)"
  if [ "$compat" -lt "$floor" ]; then
    echo "osp-web: сборка из образа старее границы отката (её уровень $compat, граница $floor) — сайт остаётся на релизе $(basename "$(readlink "$WEB_ROOT/current")")" >&2
    publish=0
  fi
fi
if [ "$publish" = 1 ]; then
  bash /opt/osp/publish.sh "$DIST" "$WEB_ROOT"
fi
exec nginx -g 'daemon off;'
