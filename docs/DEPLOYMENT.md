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
| **Готовая статика** (build output) | `/var/www/<name>/` | `danila:danila` (OSP с 2026-10, см. «Каталоги-релизы»); прежде `www-data:www-data` | То, что отдаёт nginx. `www-data` только читает. |

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

## Каталоги-релизы и откат (страховочный релиз, с 2026-10)

Новый деплой — скрипты в репозитории: [`deploy/deploy.sh`](../deploy/deploy.sh) (git pull → `npm ci` →
сборка → выкладка), [`deploy/publish.sh`](../deploy/publish.sh) (выкладка готовой сборки),
[`deploy/rollback.sh`](../deploy/rollback.sh) (откат). Проверяются тестом `npm run test:deploy`.

**Зачем.** Прежний `deploy.sh` делал `rsync --delete` прямо в отдаваемый каталог: у вкладки, открытой до
деплоя, при переходе на новую страницу пропадали файлы её сборки — белый экран. Отката не было.

**Раскладка `/var/www/osp`:**

```
/var/www/osp/
├── releases/<buildId>/     # сборка целиком, по каталогу на релиз (хранятся 5 последних)
├── assets/                 # общие хэш-файлы недавних сборок — открытые вкладки догружают свои
├── current -> releases/<buildId>   # то, что отдаёт nginx; переключается атомарно
└── shared/config.json      # runtime-конфиг (необязателен), переживает релизы
```

Владелец — `danila`, nginx (`www-data`) только читает (файлы `644`, каталоги `755`). Деплой и откат
идут **без sudo**: не нужны ни правила в `sudoers`, ни запись от имени `www-data`.

### Переход (один раз)

1. Владелец каталога — `danila`:
   ```bash
   # root#
   chown -R danila:danila /var/www/osp
   ```
2. Первая выкладка новым скриптом. Сайт в это время продолжает отдавать прежнюю раскладку — nginx ещё
   смотрит в `/var/www/osp`. Файлы прежней сборки уже лежат в `/var/www/osp/assets` и там остаются:
   ```bash
   # danila$
   bash /home/danila/projects/OSP/deploy/deploy.sh
   ls -l /var/www/osp/current          # → releases/<buildId>
   ```
3. Блок nginx `/etc/nginx/sites-available/osp.root.sx` — в серверном блоке 443 заменить `root` и
   `location`-ы на:
   ```nginx
   root /var/www/osp/current;
   index index.html;

   # Хэш-файлы всех недавних сборок — общий каталог. ^~ важнее regex-локейшена ниже.
   location ^~ /assets/ {
       root /var/www/osp;
       expires 30d;
       add_header Cache-Control "public, immutable";
       try_files $uri =404;
   }
   location = /index.html {
       add_header Cache-Control "no-cache, no-store, must-revalidate";
   }
   location = /version.json {
       add_header Cache-Control "no-cache, no-store, must-revalidate";
       try_files $uri =404;
   }
   # Runtime-конфиг: нет файла → 404 (а не index.html), приложение берёт значения сборки.
   location = /config.json {
       root /var/www/osp/shared;
       add_header Cache-Control "no-cache, no-store, must-revalidate";
       try_files $uri =404;
   }
   location / {
       try_files $uri $uri/ /index.html;
   }
   location ~* \.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|ico)$ {
       expires 30d;
       add_header Cache-Control "public, immutable";
       try_files $uri =404;
   }
   ```
   ```bash
   # root#
   nginx -t && systemctl reload nginx
   ```
4. Проверка: сайт открывается, `https://osp.root.sx/version.json` показывает `buildId` из
   `ls -l /var/www/osp/current`, `https://osp.root.sx/config.json` — 404.
5. Прежний `deploy.sh` в `/home/danila/projects/OSP` больше не запускать (переименовать в
   `deploy.sh.old`). Правило `/etc/sudoers.d/danila-deploy`, если создавалось, больше не нужно.

Старые файлы в корне `/var/www/osp` (`index.html`, `version.json`, `fonts/`) после перехода не
используются — их можно удалить через неделю.

### Обычный деплой и откат

```bash
# danila$
bash /home/danila/projects/OSP/deploy/deploy.sh      # выложить текущую ветку
bash /home/danila/projects/OSP/deploy/rollback.sh    # вернуть предыдущий релиз
bash /home/danila/projects/OSP/deploy/rollback.sh <buildId>   # вернуть конкретный
```

Откат — за секунды: переключается `current`, сборка не нужна. **Граница отката:** если релиз
объявил в `release.json` `rollbackFloor` выше уровня совместимости цели, `rollback.sh` откажет —
сервер уже убрал то, чем пользовалась старая сборка; исправление тогда только новым релизом.

### Уровень совместимости (`release.json`)

- `compat` поднимаем, когда релиз несовместим со старыми вкладками. У вкладки с меньшим уровнем окно
  «Нужно обновить страницу» — без «Позже», его можно свернуть «Сначала сохраню» в полосу сверху.
- `rollbackFloor` поднимаем вместе с миграцией, которая убирает старое на сервере.
- Старое на сервере убираем, только когда старых вкладок не осталось. Вкладки, открытые до
  страховочного релиза, опрашивают `/version.json?_=…`, новые — `/version.json?b=<buildId>&_=…`:
  ```bash
  # danila$ (с sudo — чтение логов)
  sudo grep -c 'GET /version.json?_=' /var/log/nginx/osp-access.log          # вкладки до Р1
  sudo grep -o 'GET /version.json?b=[0-9]*' /var/log/nginx/osp-access.log | sort | uniq -c
  ```

### Runtime-конфиг (`shared/config.json`)

Необязателен. Без файла всё берётся из сборки (`.env` на VPS). Формат:

```json
{
  "supabaseUrl": "https://<project>.supabase.co",
  "supabaseAnonKey": "<публичный anon-ключ>",
  "features": { "<имя-флага>": true }
}
```

Флаги `features` включают новые операции рефакторинга: выключили флаг — вернулся прежний путь, без
пересборки. Неизвестные поля и битый файл игнорируются.

## Прежний `deploy.sh` (до перехода на каталоги-релизы)

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

## Node.js 24 LTS

Проект собирается на Node.js 24: версия зафиксирована в `package.json` (`engines.node = 24.x`) и
`.nvmrc`. Node 18 снят с поддержки, а `@supabase/supabase-js` и будущий `osp-api` требуют новее.
Node на VPS нужен только для сборки: сайт отдаёт nginx из `/var/www/osp`.

**Переход — отдельным релизом, без других изменений.** Безопасно: если сборка на новом Node упадёт,
`deploy.sh` (`set -e`) остановится до `rsync`, и сайт продолжит отдавать прежнюю сборку.

```bash
# danila$ (с sudo) — установка Node.js 24 LTS через NodeSource
node --version                    # запомнить текущую (было v18.x)
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup_24.sh
sudo -E bash /tmp/nodesource_setup_24.sh
sudo apt-get install -y nodejs
node --version                    # должно показать v24.x
npm --version                     # 11.x
```

Затем деплой: новым скриптом (`npm ci` уже внутри, см. «Каталоги-релизы») либо, если переход ещё не
сделан, прежним `/home/danila/projects/OSP/deploy.sh`, заменив в нём `npm install` на **`npm ci`** —
ставит ровно то, что в `package-lock.json`, и не меняет lock-файл.

```bash
# danila$
bash /home/danila/projects/OSP/deploy/deploy.sh
```

Проверка: `deploy.sh` дошёл до `nginx -t` без ошибок; в браузере — жёсткое обновление страницы,
вход, открыть тендер и договор.

## Условные обозначения для команд

В этой документации:
- `danila$ ...` — выполнять под обычным пользователем `danila` (через `sudo` для команд, требующих root).
- `root# ...` — выполнять под root (или через `sudo -i`).
- Если в блоке нет явного префикса, в начале блока есть комментарий вида `# от danila` или `# от root`.
