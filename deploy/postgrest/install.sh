#!/usr/bin/env bash
# Установка PostgREST на сервер портала. Запускать от root:
#
#   bash /home/danila/projects/OSP/deploy/postgrest/install.sh
#
# PostgREST — тот же компонент, который отвечает страницам портала в Supabase. Здесь он слушает только
# 127.0.0.1:3001, принимает запросы только от osp-api (внутренний токен) и ходит в базу Яндекса.
# Версия закреплена, архив проверяется по контрольной сумме: не совпала — ничего не устанавливается.
# Скрипт можно запускать повторно. Секреты не трогает: файл /etc/osp-api/postgrest.env заполняется вручную.
set -euo pipefail

VERSION=14.18
SHA256=98de1c0be7787aea5f5e11a25f303ea0077634d6fc1000b687bfa825fd27d299
URL="https://github.com/PostgREST/postgrest/releases/download/v${VERSION}/postgrest-v${VERSION}-linux-static-x86-64.tar.xz"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "Запускать от root" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "Сборка рассчитана на x86_64, здесь $(uname -m)" >&2; exit 1; }
for bin in curl sha256sum tar xz systemctl; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
curl -fsSL --max-time 180 -o "$TMP/postgrest.tar.xz" "$URL"
echo "$SHA256  $TMP/postgrest.tar.xz" | sha256sum -c - >/dev/null || { echo "Контрольная сумма архива не совпала — установка отменена" >&2; exit 1; }
tar -xJf "$TMP/postgrest.tar.xz" -C "$TMP"
install -m 755 -o root -g root "$TMP/postgrest" "/usr/local/bin/postgrest-${VERSION}"
ln -sfn "/usr/local/bin/postgrest-${VERSION}" /usr/local/bin/postgrest

# Отдельный системный пользователь: без входа, без домашнего каталога.
id -u postgrest >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin postgrest
install -d -m 750 -o root -g root /etc/osp-api
if [ ! -f /etc/osp-api/postgrest.env ]; then
  install -m 600 -o root -g root "$HERE/postgrest.env.example" /etc/osp-api/postgrest.env
  echo "Создан /etc/osp-api/postgrest.env — заполните его (значения в чат и в git не попадают)."
fi
install -m 644 -o root -g root "$HERE/postgrest.service" /etc/systemd/system/postgrest.service
systemctl daemon-reload
echo "Установлено: $(/usr/local/bin/postgrest --version)"
echo "Дальше: заполнить /etc/osp-api/postgrest.env, затем systemctl enable --now postgrest"
