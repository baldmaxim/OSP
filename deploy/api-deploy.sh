#!/usr/bin/env bash
# Выкладка своего API (server/osp-api) — выполнять от root:
#
#   bash /home/danila/projects/OSP/deploy/api-deploy.sh             — текущий код ветки (git pull)
#   bash /home/danila/projects/OSP/deploy/api-deploy.sh --rollback  — вернуть предыдущий релиз
#
# Как у фронта (deploy/publish.sh): каждый релиз — свой каталог $API_ROOT/releases/<время-коммит>,
# служба (deploy/osp-api.service) запускается из $API_ROOT/current; переключение атомарное. Новый релиз
# не ответил на /api/health — current возвращается на прежний и служба перезапускается.
# Файлы — от danila (владелец), перезапуск службы — systemctl от root. Сайт это не прерывает:
# пока в config.json выключен флаг ospApiFunctions, osp-api никто из пользователей не вызывает.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/danila/projects/OSP}"
API_ROOT="${API_ROOT:-/home/danila/osp-api}"
SERVICE="${SERVICE:-osp-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/health}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
# Для проверки на временных каталогах (tests/deploy): без root, свои systemctl и пользователь.
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
APP_USER="${APP_USER-danila}"

if [ -z "${OSP_DEPLOY_TEST:-}" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Запускать от root: bash $0"; exit 1
fi
# От danila — с его HOME: иначе npm ci пишет кэш в /root/.npm и падает на правах.
as_app() {
  if [ -n "$APP_USER" ] && [ "$(id -un)" != "$APP_USER" ]; then
    runuser -u "$APP_USER" -- env HOME="$(getent passwd "$APP_USER" | cut -d: -f6)" "$@"
  else
    "$@"
  fi
}

exec 9>"${TMPDIR:-/tmp}/osp-api-deploy.lock"
flock -n 9 || { echo "Выкладка osp-api уже идёт"; exit 1; }

current_id() { if [ -L "$API_ROOT/current" ]; then basename "$(readlink "$API_ROOT/current")"; fi; }
previous_id() { if [ -L "$API_ROOT/previous" ]; then basename "$(readlink "$API_ROOT/previous")"; fi; }

point() { # point <имя ссылки> <релиз> — атомарно: rename(2) ссылки поверх старой
  as_app ln -sfn "releases/$2" "$API_ROOT/.$1.tmp"
  as_app mv -T "$API_ROOT/.$1.tmp" "$API_ROOT/$1"
}

healthy() {
  local i
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

switch_to() { # switch_to <релиз>; при отказе — назад на прежний
  local target="$1" before
  before="$(current_id)"
  point current "$target"
  "$SYSTEMCTL" restart "$SERVICE"
  if healthy; then
    if [ -n "$before" ] && [ "$before" != "$target" ]; then point previous "$before"; fi
    echo "osp-api работает: релиз $target"
    return 0
  fi
  echo "osp-api не ответил на $HEALTH_URL после перехода на $target"
  if [ -n "$before" ] && [ "$before" != "$target" ]; then
    point current "$before"
    "$SYSTEMCTL" restart "$SERVICE"
    if healthy; then echo "Возвращён прежний релиз $before — работает"; else echo "Прежний релиз $before тоже не отвечает"; fi
  fi
  echo "Причина — в журнале: journalctl -u $SERVICE -n 50 --no-pager"
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  prev="$(previous_id)"
  [ -n "$prev" ] && [ -d "$API_ROOT/releases/$prev" ] || { echo "Предыдущего релиза нет"; exit 1; }
  switch_to "$prev"
  exit $?
fi

for bin in git npm curl; do command -v "$bin" >/dev/null || { echo "Нет $bin в PATH"; exit 1; }; done

# 1. Код ветки.
if [ -z "${SKIP_PULL:-}" ]; then
  branch="$(as_app git -C "$PROJECT_DIR" branch --show-current)"
  as_app git -C "$PROJECT_DIR" pull --ff-only origin "$branch"
fi
# Время первым — сортировка имён хронологическая (чистка ниже); миллисекунды — без совпадений.
id="$(date +%Y%m%d-%H%M%S-%N | cut -c1-19)-$(as_app git -C "$PROJECT_DIR" rev-parse --short=12 HEAD)"

# 2. Релиз — во временный каталог, зависимости ровно по package-lock.json, затем переименование.
as_app mkdir -p "$API_ROOT/releases"
stage="$API_ROOT/releases/.$id.tmp"
as_app rm -rf "$stage"
as_app rsync -a --exclude node_modules "$PROJECT_DIR/server/osp-api/" "$stage/"
as_app npm ci --omit=dev --no-audit --no-fund --prefix "$stage" ${NPM_CI_EXTRA:-}
as_app mv -T "$stage" "$API_ROOT/releases/$id"

# 3. Переключение с проверкой.
switch_to "$id" || exit 1

# 4. Чистка: KEEP_RELEASES последних, current и previous — никогда.
cur="$(current_id)"; prev="$(previous_id)"
mapfile -t releases < <(find "$API_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' | sort -r)
n=0
for r in "${releases[@]}"; do
  n=$((n + 1))
  if [ "$n" -gt "$KEEP_RELEASES" ] && [ "$r" != "$cur" ] && [ "$r" != "$prev" ]; then
    as_app rm -rf "${API_ROOT:?}/releases/$r"
  fi
done
