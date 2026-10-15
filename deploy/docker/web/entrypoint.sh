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
# Адрес клиента от общего nginx — по жетону (nginx.conf). Жетон — только латиница и цифры, 32–128 знаков.
# Нет или негодный — адрес клиента не известен: за общим nginx все запросы приходят с одного адреса, и лимит
# /api/ по нему стал бы одним на всех. Поэтому без жетона лимит по адресу не действует (пустой ключ nginx
# не считает) — остаются лимиты osp-api по пользователю.
token_ok=0
[[ "${OSP_EDGE_TOKEN:-}" =~ ^[A-Za-z0-9]{32,128}$ ]] && token_ok=1
{
  echo 'map $http_x_osp_edge $osp_client_ip {'
  echo '    default $remote_addr;'
  if [ "$token_ok" = 1 ]; then echo "    \"$OSP_EDGE_TOKEN\" \$http_x_osp_client_ip;"; fi
  echo '}'
  echo 'map $http_x_osp_edge $osp_api_limit_key {'
  if [ "$token_ok" = 1 ]; then echo '    default $osp_client_ip;'; else echo '    default "";'; fi
  echo '}'
} > /tmp/osp-edge.conf
if [ "$token_ok" != 1 ]; then
  echo "osp-web: OSP_EDGE_TOKEN не задан — адрес клиента не известен, лимит /api/ по адресу выключен (deploy-server.sh edge-token-init)" >&2
fi
exec nginx -g 'daemon off;'
