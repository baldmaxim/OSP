#!/usr/bin/env bash
# Запись портала ОСП для общего nginx сервера — из шаблона, на одно имя сайта. Только печатает файл:
#
#   bash render.sh <имя сайта> --http-only > <имя>.conf   # шаг 1: до выпуска сертификата
#   bash render.sh <имя сайта>            > <имя>.conf   # шаг 2: сертификат выпущен — с блоком HTTPS
#
# Два шага нужны потому, что блок HTTPS ссылается на файлы сертификата: пока их нет, общий nginx такую
# запись не примет. Сначала ставится запись «только HTTP» (в ней адрес проверки Let's Encrypt), по ней
# выпускается сертификат, затем запись заменяется полной. Порядок — deploy/docker/README.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${1:-}"; MODE="${2:-}"
[[ "$NAME" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "Использование: bash render.sh <имя сайта> [--http-only]" >&2; exit 1; }
[ -z "$MODE" ] || [ "$MODE" = --http-only ] || { echo "Использование: bash render.sh <имя сайта> [--http-only]" >&2; exit 1; }
TEMPLATE="${OSP_NGINX_TEMPLATE:-$HERE/site.conf.template}"
# Жетон адреса клиента (deploy/docker/web/nginx.conf): из окружения или из secrets/osp-web.env портала.
TOKEN="${OSP_EDGE_TOKEN:-}"
WEB_ENV="${OSP_HOME:-/opt/portals/osp}/secrets/osp-web.env"
if [ -z "$TOKEN" ] && [ -r "$WEB_ENV" ]; then
  TOKEN="$(grep -m 1 -E '^OSP_EDGE_TOKEN=' "$WEB_ENV" | cut -d= -f2- || true)"
fi
if [[ "$TOKEN" =~ ^[A-Za-z0-9]{32,128}$ ]]; then
  EDGE="proxy_set_header X-OSP-Edge $TOKEN;"
else
  EDGE="# жетона нет (secrets/osp-web.env): контейнер сайта видит только адрес общего nginx"
fi
if [ "$MODE" = --http-only ]; then
  grep -v '^#@https' "$TEMPLATE"
else
  sed -E 's/^#@https ?//' "$TEMPLATE"
fi | sed -e "s/__NAME__/$NAME/g" -e "s|__EDGE_HEADER__|$EDGE|"
