# Архитектура развёртывания (Ubuntu + Nginx, мультихостинг)

Документ описывает фактическое состояние развёртывания OSP-портала на VPS под пользователем `danila` и правила, которые должны соблюдаться, чтобы будущие сайты на этом же сервере не ломали друг друга при деплое.

## Принцип изоляции

> **Каждый сайт — отдельный «остров»: своя директория исходников, своя директория готовой статики, свой server-block nginx, свой сертификат, свои логи. Глобальные сервисы (nginx, certbot) общие, но их конфиги модульны.**

Никакой деплой-скрипт одного сайта не должен:
- править чужие server-block'и nginx,
- перезапускать nginx (только `reload`, и только после `nginx -t`),
- трогать общие сертификаты или каталоги других проектов,
- занимать общий 80/443 каким-либо своим процессом,
- rsync'ить в общий `/var/www/html` — это «общая корзина», `--delete` затрёт чужие файлы.

## Двухступенчатая раскладка: исходники vs. статика

| Что | Где | Кто владеет | Зачем |
|-----|-----|------------|-------|
| **Исходники** проекта | `/home/danila/projects/<name>/` | `danila:danila` | Git, `npm`, разработка. Полные права у пользователя. |
| **Готовая статика** (build output) | `/var/www/<name>/` | `www-data:www-data` | То, что отдаёт nginx. Read-only для всех, кроме `www-data`. |

Почему не отдавать nginx прямо из `~/projects/<name>/dist/`: на Ubuntu по умолчанию `/home/<user>` имеет права `0750` без `o+x` для других пользователей, поэтому `nginx` (user `www-data`) не может пройти внутрь и отдаёт `403`. Открывать `o+x` на home — портить безопасность сервера. Правильнее `deploy.sh` копирует собранный `dist/` в `/var/www/<name>/`, который доступен `www-data`.

## Файловая структура

```
/home/danila/projects/
├── OSP/                          # исходники OSP (этот репо)
│   ├── dist/                      # vite build output — промежуточный, потом копируется в /var/www/osp
│   ├── deploy.sh                  # скрипт обновления (см. ниже)
│   └── .env                       # секреты (не в git)
├── <другой-сайт>/                # будущий сайт — отдельный каталог
│   └── dist/
└── ...

/var/www/
├── osp/                          # ← nginx читает отсюда для osp.root.sx
│   ├── index.html
│   └── assets/...
├── <другой-сайт>/                # ← per-site, не сливаются друг с другом
└── html/                         # дефолтная корзина Ubuntu — мы её не используем

/etc/nginx/
├── nginx.conf                     # общий, трогаем редко
├── sites-available/
│   ├── osp.root.sx                # ← наш server-block
│   ├── default                    # ← заглушка для запросов без подходящего домена
│   └── <другой-сайт>.tld          # будущие сайты
└── sites-enabled/
    ├── osp.root.sx -> ../sites-available/osp.root.sx
    └── default -> ../sites-available/default

/etc/letsencrypt/
├── live/
│   ├── osp.root.sx/               # cert/privkey OSP
│   │   ├── fullchain.pem
│   │   └── privkey.pem
│   └── <другой-сайт>.tld/
└── renewal/                       # параметры renewal на каждый домен

/var/log/nginx/
├── osp-access.log                 # отдельные логи на сайт
├── osp-error.log
└── ...
```

## Nginx server-block для OSP (`/etc/nginx/sites-available/osp.root.sx`)

После выпуска сертификата certbot сам дописал блок 443 и редирект с 80 на 443. Базовое содержимое сейчас (схематически):

```nginx
# HTTP → редирект на HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name osp.root.sx;
    return 301 https://$host$request_uri;   # certbot прописал
}

# HTTPS — реальный отдающий блок
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name osp.root.sx;

    root /var/www/osp;                # ← per-site, не /var/www/html
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    access_log /var/log/nginx/osp-access.log;
    error_log  /var/log/nginx/osp-error.log;

    ssl_certificate     /etc/letsencrypt/live/osp.root.sx/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/osp.root.sx/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparam.pem;
}
```

## Сертификаты (Certbot + Let's Encrypt)

- Один **сертификат на домен** (а не один общий на все сайты). Обновление сертификата одного сайта не задевает другие.
- Auto-renewal — через системный таймер `certbot.timer`, ставится автоматически при `apt install certbot`. Проверка: `systemctl list-timers | grep certbot`.
- Renewal hook: после обновления certbot reload-ит nginx, без даунтайма.

### Dry-run перед реальным выпуском

`--dry-run` работает **только** с subcommand'ами `certonly` и `renew`, **не** с `certbot --nginx` (тот запускает subcommand `run`):

```bash
# danila$ (с sudo)
sudo certbot certonly --nginx --dry-run \
  -d <domain> \
  --agree-tos \
  --register-unsafely-without-email
```

После успеха — реальный выпуск:

```bash
# danila$ (с sudo)
sudo certbot --nginx \
  -d <domain> \
  --redirect \
  --agree-tos \
  --email <email> \
  --no-eff-email
```

## Текущий `deploy.sh` и что в нём улучшить

Файл `/home/danila/projects/OSP/deploy.sh` (после правки от 2026-05-20):

```bash
#!/bin/bash
set -e

PROJECT_DIR="/home/danila/projects/OSP"
WEB_DIR="/var/www/osp"                    # ← per-site (раньше было /var/www/html)
BRANCH="$(git -C /home/danila/projects/OSP branch --show-current)"

cd "$PROJECT_DIR"
git pull origin "$BRANCH"
npm install
npm run build
test -f "$PROJECT_DIR/dist/index.html"

sudo rsync -av --delete "$PROJECT_DIR/dist/" "$WEB_DIR/"
sudo chown -R www-data:www-data "$WEB_DIR"
sudo chmod -R 755 "$WEB_DIR"
sudo nginx -t
sudo systemctl reload nginx
```

Работает, но для мультихостинга стоит улучшить (по мере появления второго сайта):

1. **`flock`** против параллельных запусков. Иначе два одновременных `deploy.sh` могут оставить `/var/www/osp/` в полуразобранном состоянии.
   ```bash
   exec 9>/tmp/osp-deploy.lock
   flock -n 9 || { echo "deploy уже идёт"; exit 1; }
   ```
2. **Безопасный `npm`** — `npm ci` вместо `npm install`: ставит ровно то, что в `package-lock.json`, не модифицирует lock-файл.
3. **`set -euo pipefail`** вместо `set -e`: ловить и unset-переменные, и ошибки в pipeline.
4. **Атомарный swap** вместо `rsync --delete` напрямую в активный каталог. Сейчас во время `rsync` пользователи могут поймать страницу со старым `index.html` и новыми хеш-именами ассетов (или наоборот) — 404 в течение секунд. Решение: rsync во временный каталог, потом atomic `mv`:
   ```bash
   STAGING="$(sudo mktemp -d -p /var/www ".${PROJECT_NAME}.staging-XXXX")"
   sudo rsync -a "$PROJECT_DIR/dist/" "$STAGING/"
   sudo chown -R www-data:www-data "$STAGING"
   sudo chmod -R 755 "$STAGING"
   sudo rm -rf "${WEB_DIR}.old" 2>/dev/null || true
   sudo mv "$WEB_DIR" "${WEB_DIR}.old"
   sudo mv "$STAGING" "$WEB_DIR"
   sudo rm -rf "${WEB_DIR}.old"
   ```
5. **`sudo` без пароля** — настроить `/etc/sudoers.d/danila-deploy` под узкие команды, чтобы `deploy.sh` не запрашивал пароль:
   ```
   # /etc/sudoers.d/danila-deploy  (создаётся через `visudo -f`, под root)
   danila ALL=(root) NOPASSWD: /usr/bin/rsync -av --delete /home/danila/projects/OSP/dist/ /var/www/osp/, \
                                /usr/bin/chown -R www-data\:www-data /var/www/osp, \
                                /usr/bin/chmod -R 755 /var/www/osp, \
                                /usr/sbin/nginx -t, \
                                /bin/systemctl reload nginx
   ```
   Никаких `NOPASSWD: ALL`.

Эти улучшения не нужны прямо сейчас — текущий `deploy.sh` рабочий. Но при подключении второго сайта стоит унифицировать стиль скриптов.

## Заглушить `default` server-block

Сейчас `/etc/nginx/sites-available/default` имеет `server_name _;` и отдаёт `/var/www/html/`. Это значит: любой неизвестный домен, указавший A-записью на твой IP (включая боты/спам-сканеры), получает старую копию OSP. Для мультихостинга и просто гигиены лучше превратить default в заглушку:

```nginx
# /etc/nginx/sites-available/default
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;   # закрыть соединение молча
}
```

```bash
# danila$ (с sudo)
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak
sudoedit /etc/nginx/sites-available/default   # заменить содержимое на блок выше
sudo nginx -t && sudo systemctl reload nginx
```

После этого `curl -I http://<любой-неизвестный-домен>` к серверу будет получать обрыв соединения, а `osp.root.sx` продолжит работать.

## Firewall (ufw)

```bash
# danila$ (с sudo)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow OpenSSH
sudo ufw enable        # если ещё не включён
sudo ufw status verbose
```

## Чек-лист добавления нового сайта на этот же VPS

| # | Действие | От кого | Команда / детали |
|---|----------|---------|------------------|
| 1 | Положить исходники | `danila` | `git clone ... /home/danila/projects/<name>` |
| 2 | Создать корневой каталог статики | `root` (или `danila` через `sudo`) | `sudo mkdir -p /var/www/<name> && sudo chown www-data:www-data /var/www/<name>` |
| 3 | Создать server-block | `root` | `/etc/nginx/sites-available/<domain>` по образцу OSP: меняем `server_name`, `root /var/www/<name>`, имена логов |
| 4 | Симлинк + reload | `root` | `ln -s ../sites-available/<domain> /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx` |
| 5 | Выпустить сертификат | `danila` (с sudo) | `sudo certbot --nginx -d <domain> --redirect --agree-tos --email <email>` |
| 6 | Скопировать и адаптировать `deploy.sh` | владелец проекта | Скопировать из OSP, поменять `PROJECT_DIR` и `WEB_DIR` |
| 7 | Прогнать deploy первый раз | `danila` | `cd /home/danila/projects/<name> && ./deploy.sh` |
| 8 | Проверить, что OSP не лёг | с любой машины | `curl -I https://osp.root.sx` → 200 |

## Полезные команды диагностики

```bash
# danila$ (read-only — без sudo)
ls -l /etc/nginx/sites-enabled/                 # активные сайты
systemctl list-timers | grep certbot            # таймер обновления сертификатов

# danila$ (с sudo)
sudo certbot certificates                       # все домены и сроки
sudo certbot renew --dry-run                    # симуляция renewal
sudo nginx -t                                   # тест конфигурации
sudo tail -f /var/log/nginx/osp-access.log /var/log/nginx/osp-error.log
sudo ss -tlnp | grep -E ':80 |:443 '            # кто слушает 80/443
```

## Известные предупреждения

### Node.js 18 → Supabase требует 20+

В `npm install` сейчас сыпятся предупреждения:
```
npm WARN EBADENGINE Unsupported engine {
  package: '@supabase/supabase-js@2.80.0',
  required: { node: '>=20.0.0' },
  current: { node: 'v18.19.1', npm: '9.2.0' }
}
```

Сборка проходит (Vite транспилирует код), но в перспективе апгрейд узла на VPS:

```bash
# danila$ (с sudo) — установка Node.js 20 LTS через NodeSource
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # должно показать v20.x
```

После апгрейда — заново `npm ci && npm run build` в проекте OSP.

## Условные обозначения для команд

В этой документации:
- `danila$ ...` — выполнять под обычным пользователем `danila` (через `sudo` для команд, требующих root).
- `root# ...` — выполнять под root (или через `sudo -i`).
- Если в блоке нет явного префикса, в начале блока есть комментарий вида `# от danila` или `# от root`.
