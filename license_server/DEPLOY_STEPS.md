# Быстрый деплой обновлённого воркера

## 📌 После любой правки в `src/worker.js` или `wrangler.toml`

```bash
cd license-server
git pull                 # если работаете в Git
git add .
git commit -m "fix: CORS whitelist для localhost"
git push

# На той машине, где wrangler (или у себя локально)
npx wrangler deploy      # задеплоит воркер на Cloudflare
```

Это занимает 5-10 секунд. После этого обновление видно на URL'е воркера.

## 📌 Проверить что задеплоилось

```bash
# Healthcheck
curl https://aeroopt-license-server.<ваш-subdomain>.workers.dev/healthz

# Проверить CORS (должен вернуть Access-Control-Allow-Origin):
curl -X OPTIONS https://aeroopt-license-server.<ваш-subdomain>.workers.dev/v1/activate \
  -H "Origin: http://localhost:8000" \
  -H "Access-Control-Request-Method: POST" \
  -i
# В заголовках должно быть:
#   access-control-allow-origin: http://localhost:8000
```

## 📌 Если воркер ещё не задеплоен

См. `INTEGRATE_LICENSE.md`, шаги 1-6. Кратко:

```bash
cd license-server
npm install
npx wrangler login

# D1
npx wrangler d1 create aeroopt-licenses
# (вставить database_id в wrangler.toml)
npx wrangler d1 execute aeroopt-licenses --file=schema.sql
npx wrangler d1 execute aeroopt-licenses --file=seed.sql

# Secrets
openssl rand -hex 32 | npx wrangler secret put LICENSE_HMAC_KEY
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN

# Deploy
npx wrangler deploy
```

## 📌 Как посмотреть все ключи

Через CLI (есть у вас в репо):
```bash
cd license-server
export ADMIN_TOKEN=ваш_токен_из_wrangler_secret
node admin_cli.js list
```

Через веб-админку (`admin/index.html`):
1. Задеплойте сайт на Cloudflare Pages
2. Откройте `aeroopt.app/admin/` (или `aeroopt-site.pages.dev/admin/`)
3. Введите ADMIN_TOKEN
4. Увидите таблицу всех ключей

Через D1 напрямую:
```bash
npx wrangler d1 execute aeroopt-licenses --command="SELECT license_key, email, product, issued_at, max_hwid_count, note, revoked_at FROM licenses ORDER BY issued_at DESC"
```

## 📌 Как выдать новый ключ

CLI:
```bash
node admin_cli.js issue --email student@mit.edu --product edu --max-machines 1 --note "МФТИ, диплом"
```

Через админку: форма "Выдать ключ" вверху страницы.

## 📌 Что выводит `node admin_cli.js issue`

```
⏳ Генерирую ключ для student@mit.edu (edu)...

✅ Ключ выдан:
   License key: AERO-EDUC-XXXX-XXXX-XXXX-XXXX
   Email:       student@mit.edu
   Product:     edu
   Machines:    1
   Expires:     бессрочно
   Note:        МФТИ, диплом
   Email:       sent   (если настроен Resend)
```

Ключ сразу можно ввести в AeroOpt.

## 📌 Важно: переменные окружения для CLI

Чтобы CLI мог подключиться к воркеру, задайте:
```bash
export LICENSE_SERVER=https://aeroopt-license-server.<ваш-subdomain>.workers.dev
export ADMIN_TOKEN=<тот_же_токен_что_в_wrangler_secret>
```

Или создайте файл `license-server/.env`:
```
LICENSE_SERVER=https://aeroopt-license-server.<ваш-subdomain>.workers.dev
ADMIN_TOKEN=<ваш_токен>
```

CLI автоматически прочитает `.env`.
