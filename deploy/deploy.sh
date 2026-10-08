#!/usr/bin/env bash
# Деплой ОСП на VPS — выполнять от danila, без sudo:
#
#   bash /home/danila/projects/OSP/deploy/deploy.sh
#
# git pull → npm ci → сборка → выкладка в каталоги-релизы (deploy/publish.sh).
# Сайт не прерывается: новая сборка подменяет старую атомарно, открытые вкладки
# догружают свои файлы из общего каталога assets/. Откат — deploy/rollback.sh.
# Подготовка сервера (один раз) — docs/DEPLOYMENT.md, «Каталоги-релизы».
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/danila/projects/OSP}"
WEB_ROOT="${WEB_ROOT:-/var/www/osp}"

# Два деплоя одновременно оставили бы каталоги в полуразобранном виде.
exec 9>"/tmp/osp-deploy.lock"
flock -n 9 || { echo "Деплой уже идёт (/tmp/osp-deploy.lock)"; exit 1; }

cd "$PROJECT_DIR"
BRANCH="$(git branch --show-current)"
git pull --ff-only origin "$BRANCH"
npm ci          # ровно то, что в package-lock.json; lock-файл не меняется
npm run build   # при ошибке set -e остановит деплой — сайт отдаёт прежний релиз

bash "$PROJECT_DIR/deploy/publish.sh" "$PROJECT_DIR/dist" "$WEB_ROOT"
