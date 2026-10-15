#!/usr/bin/env bash
# Файлы настроек для сервера портала — из файла подключения к базе Яндекса. Запускать на удалённой
# машине; на сервер портала файлы переносит Cursor (scp), значения на экран не выводятся:
#
#   bash migration/target/server-env.sh ~/.osp-secrets/target.env ~/.osp-secrets/server
#
# Создаёт в каталоге (права 700, файлы 600):
#   postgrest.env   — целиком готовый /etc/osp-api/postgrest.env;
#   osp-api.add.env — строки, которые дописываются в /etc/osp-api/osp-api.env (шлюз и подключение к базе);
#   db-host         — адрес и порт базы для проверки сети с сервера портала.
# Внутренний секрет шлюза создаётся здесь же, один на оба файла. Пароль в строках подключения
# кодируется (%XX). Повторный запуск создаёт новый секрет — тогда оба файла на сервере меняются вместе.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib/conn.sh
. "$HERE/lib/conn.sh"
ENV_FILE="${1:-}"; OUT="${2:-}"
[ -n "$ENV_FILE" ] && [ -n "$OUT" ] || { echo "Использование: bash migration/target/server-env.sh <файл подключения> <каталог>" >&2; exit 1; }
for bin in python3 openssl; do command -v "$bin" >/dev/null || { echo "Нужен $bin" >&2; exit 1; }; done
target_conn "$ENV_FILE" || exit 1
case "${PGHOST:-}" in *,*) echo "В файле подключения несколько адресов: для служб нужен один (адрес мастера кластера)" >&2; exit 1 ;; esac
[ -n "${PGPASSWORD:-}" ] || { echo "В файле подключения нет пароля: службам он нужен в файле настроек" >&2; exit 1; }

umask 077
mkdir -p "$OUT"; chmod 700 "$OUT"
SECRET="$(openssl rand -base64 48 | tr -d '\n')"
CA=/etc/ssl/osp/yandex-root.crt
export OSP_ENV_OUT="$OUT" OSP_ENV_SECRET="$SECRET" OSP_ENV_CA="$CA" OSP_ENV_TEMPLATE="$ROOT/deploy/postgrest/postgrest.env.example"
python3 - <<'PY'
import os
from urllib.parse import quote
e = os.environ
out = e['OSP_ENV_OUT']
user, password, host, port, db = (e['PGUSER'], e['PGPASSWORD'], e['PGHOST'], e.get('PGPORT') or '6432', e['PGDATABASE'])
auth = f"{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}/{quote(db, safe='')}"
# PostgREST понимает параметры libpq; osp-api принимает только sslmode=verify-full и свой файл сертификата.
pgrst_uri = f"postgres://{auth}?sslmode=verify-full&sslrootcert={e['OSP_ENV_CA']}&application_name=osp-postgrest"
api_uri = f"postgres://{auth}?sslmode=verify-full"
lines = []
for line in open(e['OSP_ENV_TEMPLATE'], encoding='utf-8').read().split('\n'):
    if line.startswith('PGRST_DB_URI='): line = 'PGRST_DB_URI=' + pgrst_uri
    elif line.startswith('PGRST_JWT_SECRET='): line = 'PGRST_JWT_SECRET=' + e['OSP_ENV_SECRET']
    lines.append(line)
def write(name, text):
    path = os.path.join(out, name)
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as f:
        f.write(text)
write('postgrest.env', '\n'.join(lines))
write('osp-api.add.env', '\n'.join([
    '# Шлюз данных и подключение к базе Яндекса (migration/target/server-env.sh).',
    'OSP_PGRST_URL=http://127.0.0.1:3001',
    'OSP_PGRST_JWT_SECRET=' + e['OSP_ENV_SECRET'],
    'OSP_PGRST_DB_ROLE=' + user,
    'OSP_DB_READONLY_FILE=/var/lib/osp-api/db-readonly',
    'OSP_DB_URL=' + api_uri,
    'OSP_DB_CA_FILE=' + e['OSP_ENV_CA'],
    'OSP_DB_POOL_MAX=4',
    'OSP_REGISTRY_REFRESH=1',
    '# Свой вход (migration/CUTOVER.md, «Свой вход tender.su10.ru»): пока supabase — вход как сейчас. Ключ',
    '# шифрования паролей OSP_AUTH_KEYS дописывает scripts/deploy-server.sh auth-key-init; режим меняет auth-mode.',
    'AUTH_MODE=supabase',
    'OSP_PUBLIC_ORIGIN=https://tender.su10.ru',
    '',
]))
write('db-host', f'{host} {port}\n')
PY
echo "OK созданы: postgrest.env, osp-api.add.env, db-host — в каталоге ${OUT/#$HOME/~} (права 600; значения не выводились)"
echo "Дальше — migration/CUTOVER.md, раздел А."
