#!/usr/bin/env bash
# Выкладка своего API (server/osp-api) — выполнять от root:
#
#   bash /home/danila/projects/OSP/deploy/api-deploy.sh             — текущий код ветки (git pull)
#   bash /home/danila/projects/OSP/deploy/api-deploy.sh --rollback  — вернуть предыдущий релиз
#
# Как у фронта (deploy/publish.sh): каждый релиз — свой каталог $API_ROOT/releases/<время-коммит>,
# служба (deploy/osp-api.service, пользователь osp-api) запускается из $API_ROOT/current; переключение
# атомарное. Новый релиз не прошёл /api/ready (обязательные зависимости отвечают с текущими ключами) —
# current возвращается на прежний и служба перезапускается. Прежнего нет (первый релиз в $API_ROOT) —
# служба останавливается, а current убирается: непроверенный релиз не работает и не станет previous.
# Файлы релизов пишет danila, служба только читает.
# Сайт это не прерывает: пока флаги ospApiAi / ospApiFiles выключены, osp-api никто не вызывает.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/danila/projects/OSP}"
API_ROOT="${API_ROOT:-/opt/osp-api}"
SERVICE="${SERVICE:-osp-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/ready}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
# Node, которым служба запускает код (ExecStart в osp-api.service): нужен 20 или новее.
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
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

# 200 — готов. 503 — служба поднялась, но зависимость не отвечает (неверный ключ, нет связи):
# после трёх таких ответов — отказ с перечнем проверок (в нём только ok / fail / not_configured).
healthy() {
  local i code fails=0
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then return 0; fi
    if [ "$code" = "503" ]; then
      fails=$((fails + 1))
      if [ "$fails" -ge 3 ]; then
        echo "Готовность: зависимости не отвечают — $(curl -s -m 10 "$HEALTH_URL" 2>/dev/null || true)"
        return 1
      fi
    fi
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
  elif [ -z "$before" ]; then
    "$SYSTEMCTL" stop "$SERVICE" || true
    as_app rm -f "$API_ROOT/current"
    echo "Прежнего релиза нет — служба остановлена. Флаги ospApiAi / ospApiFiles не включать"
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
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null ||
  { echo "Нужен Node 20 или новее в $NODE_BIN — им служба запускает osp-api"; exit 1; }

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
as_app chmod -R a+rX "$stage" # служба (пользователь osp-api) только читает
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
