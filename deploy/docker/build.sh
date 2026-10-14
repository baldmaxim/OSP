#!/usr/bin/env bash
# Сборка выпуска портала для сервера: образы из точного коммита и файлы установки — одним каталогом.
# Запускается на машине сборки или на самом сервере через scripts/deploy-server.sh — тогда собирает свой
# сборщик buildx с потолком памяти и процессора (OSP_BUILDER), чтобы не отнимать их у соседних порталов:
#
#   bash deploy/docker/build.sh [--out <каталог>]      # по умолчанию deploy/docker/out (вне git)
#   bash deploy/docker/build.sh … --no-save            # без images.tar.gz: образы уже на этой машине (сервер)
#   bash deploy/docker/build.sh … --only api|web --reuse <release.env выложенного выпуска>
#                                                      # собрать один образ, второй взять из выложенного
#
# Результат — каталог osp-release-<коммит>/:
#   images.tar.gz        — образы osp-api, osp-web (метка = коммит) и PostgREST закреплённой версии;
#   compose.yml, deploy.sh, neighbors.sh, infra-nginx/ — файлы установки этого же коммита;
#   release.env          — имена образов выпуска; MANIFEST — коммит, сборка и отпечатки образов
#                          (слои и параметры запуска — одинаковы на машине сборки и на сервере);
#   SHA256SUMS           — контрольные суммы всех файлов: на сервере сверяются до загрузки образов.
# Каталог переносится на сервер целиком; там — bash deploy.sh install <каталог> (deploy/docker/README.md).
#
# Образ собирается только из закоммиченного: исходники берутся не из рабочего каталога, а выгружаются из
# коммита (git archive) во временный каталог. Чьи-то несохранённые правки в рабочем каталоге в образ не
# попадают; о них скрипт только предупреждает.
# Адрес и публичный ключ Supabase для сайта — из файла (две строки VITE_SUPABASE_URL=…,
# VITE_SUPABASE_ANON_KEY=…; по умолчанию ~/.osp-secrets/web-build.env). Это не секреты (они вшиты в
# любую сборку сайта), но на экран не выводятся. Секретов сервера в образах и в выпуске нет.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"
WEB_ENV="${OSP_WEB_BUILD_ENV:-$HOME/.osp-secrets/web-build.env}"
ONLY=""; REUSE=""; SAVE=1
usage() { echo "Использование: bash deploy/docker/build.sh [--out <каталог>] [--no-save] [--only api|web --reuse <release.env>]" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?укажите каталог}"; shift 2 ;;
    --no-save) SAVE=0; shift ;;
    --only) ONLY="${2:-}"; [ "$ONLY" = api ] || [ "$ONLY" = web ] || usage; shift 2 ;;
    --reuse) REUSE="${2:-}"; [ -f "$REUSE" ] || { echo "Нет файла выпуска: $REUSE" >&2; exit 1; }; shift 2 ;;
    *) usage ;;
  esac
done
{ [ -z "$ONLY" ] && [ -z "$REUSE" ]; } || { [ -n "$ONLY" ] && [ -n "$REUSE" ]; } || usage
for bin in docker git sha256sum gzip; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done

# Пути, из которых собираются образы и берутся файлы установки.
BUILD_PATHS=(src public server/osp-api index.html vite.config.js release.json package.json package-lock.json deploy/publish.sh deploy/docker .dockerignore)
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
# Источник сборки. Обычно — выгрузка коммита; OSP_BUILD_DIRTY=1 (только для тестов) — рабочий каталог.
if [ -n "${OSP_BUILD_DIRTY:-}" ]; then
  SRC="$ROOT"
else
  if [ -n "$(git -C "$ROOT" status --porcelain -- "${BUILD_PATHS[@]}")" ]; then
    echo "ВНИМАНИЕ в рабочем каталоге есть несохранённые правки в путях сборки — в выпуск они НЕ войдут (собирается коммит ${COMMIT:0:12}):"
    git -C "$ROOT" status --short -- "${BUILD_PATHS[@]}"
  fi
  SRC="$(mktemp -d)"
  trap 'rm -rf -- "${SRC:?}"' EXIT
  git -C "$ROOT" archive "$COMMIT" -- "${BUILD_PATHS[@]}" | tar -x -C "$SRC"
fi
SRC_DOCKER="$SRC/deploy/docker"
TAG="${COMMIT:0:12}"
# Идентификатор сборки сайта — время коммита в миллисекундах: один и тот же коммит даёт ту же сборку.
BUILD_ID="$(($(git -C "$ROOT" show -s --format=%ct HEAD) * 1000))"

# Значение ключа из файла сборки сайта: файл разбирается, а не исполняется.
web_arg() { grep -m 1 -E "^$1=" "$WEB_ENV" 2>/dev/null | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" || true; }
SUPA_URL="$(web_arg VITE_SUPABASE_URL)"
SUPA_KEY="$(web_arg VITE_SUPABASE_ANON_KEY)"
if [ -z "$SUPA_URL" ] || [ -z "$SUPA_KEY" ]; then
  echo "FAIL нет адреса или публичного ключа Supabase для сайта: файл $WEB_ENV, строки VITE_SUPABASE_URL= и VITE_SUPABASE_ANON_KEY=" >&2
  exit 1
fi

# PostgREST: версия и отпечаток образа закреплены в репозитории (deploy/docker/postgrest.image).
PGRST="$(grep -v '^#' "$SRC_DOCKER/postgrest.image" | head -n 1)"
PGRST_REF="${PGRST%@*}"; PGRST_DIGEST="${PGRST#*@}"
docker image inspect "$PGRST_REF" >/dev/null 2>&1 || docker pull -q "$PGRST" >/dev/null
docker image inspect "$PGRST_REF" --format '{{join .RepoDigests "\n"}}' | grep -q "@$PGRST_DIGEST\$" || {
  echo "FAIL образ $PGRST_REF на этой машине — не тот, что закреплён (отпечаток не совпал)" >&2; exit 1; }

echo "Сборка выпуска $TAG (сборка сайта $BUILD_ID)${ONLY:+, собирается только $ONLY}…"
LABELS=(--label "org.opencontainers.image.revision=$COMMIT" --label "org.opencontainers.image.title=osp")
# Свой сборщик (scripts/deploy-server.sh: buildx с потолком памяти и процессора) или обычная сборка.
build_image() {
  if [ -n "${OSP_BUILDER:-}" ]; then docker buildx build --builder "$OSP_BUILDER" --load -q "$@" >/dev/null
  else docker build -q "$@" >/dev/null; fi
}
# Образ из выложенного выпуска — под меткой нового: уборка старых выпусков снимает метки своих выпусков,
# и образ, который продолжает работать, должен держаться за метку текущего.
reuse_image() { # reuse_image api|web
  local key ref
  key="OSP_$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')_IMAGE"
  ref="$(grep -m 1 -E "^$key=" "$REUSE" | cut -d= -f2-)"
  [[ "$ref" =~ ^osp-$1:[0-9a-f]{12}$ ]] || { echo "FAIL в $REUSE нет $key" >&2; exit 1; }
  docker image inspect "$ref" >/dev/null 2>&1 || { echo "FAIL образа $ref на этой машине нет — соберите оба: без --only" >&2; exit 1; }
  docker tag "$ref" "osp-$1:$TAG"
  echo "Образ osp-$1 — из выложенного выпуска (${ref#*:})"
}
if [ "$ONLY" != web ]; then
  build_image -f "$SRC_DOCKER/api.Dockerfile" -t "osp-api:$TAG" "${LABELS[@]}" "$SRC"
else
  reuse_image api
fi
if [ "$ONLY" != api ]; then
  build_image -f "$SRC_DOCKER/web.Dockerfile" -t "osp-web:$TAG" "${LABELS[@]}" \
    --build-arg "VITE_SUPABASE_URL=$SUPA_URL" --build-arg "VITE_SUPABASE_ANON_KEY=$SUPA_KEY" --build-arg "OSP_BUILD_ID=$BUILD_ID" "$SRC"
else
  reuse_image web
fi

REL="$OUT/osp-release-$TAG"
rm -rf "$REL"; mkdir -p "$REL/infra-nginx"
cp "$SRC_DOCKER/compose.yml" "$SRC_DOCKER/deploy.sh" "$SRC_DOCKER/neighbors.sh" "$REL/"
cp "$SRC_DOCKER/infra-nginx/site.conf.template" "$SRC_DOCKER/infra-nginx/render.sh" "$SRC_DOCKER/infra-nginx/install.sh" "$REL/infra-nginx/"
printf '%s\n' "OSP_TAG=$TAG" "OSP_API_IMAGE=osp-api:$TAG" "OSP_WEB_IMAGE=osp-web:$TAG" "OSP_POSTGREST_IMAGE=$PGRST_REF" > "$REL/release.env"
print_of() { bash "$SRC_DOCKER/deploy.sh" fingerprint "$1"; }
{
  echo "commit=$COMMIT"
  echo "tag=$TAG"
  echo "build_id=$BUILD_ID"
  echo "image osp-api:$TAG $(print_of "osp-api:$TAG")"
  echo "image osp-web:$TAG $(print_of "osp-web:$TAG")"
  echo "image $PGRST_REF $(print_of "$PGRST_REF")"
} > "$REL/MANIFEST"
if [ "$SAVE" = 1 ]; then
  docker save "osp-api:$TAG" "osp-web:$TAG" "$PGRST_REF" | gzip -c > "$REL/images.tar.gz"
fi
(cd "$REL" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)

if [ "$SAVE" = 1 ]; then
  echo "OK выпуск собран: $(basename "$REL"), образы — $(du -h "$REL/images.tar.gz" | cut -f1)"
else
  echo "OK выпуск собран: $(basename "$REL"), образы — на этой машине (без архива)"
fi
echo "Каталог: ${REL#"$PWD"/}"
