# Деплой license-сервера AeroOpt — пошаговая инструкция

## 📌 Что это

License-сервер — это Cloudflare Worker (serverless-функция), который:
- Принимает `POST /v1/activate` — привязка HWID к ключу
- Принимает `POST /v1/heartbeat` — ежемесячная проверка
- Принимает `POST /v1/run_token` — одноразовый токен на запуск SU2
- Принимает `POST /v1/account_info` — для личного кабинета
- Принимает admin-запросы `/v1/admin/*` (выпуск / отзыв / список ключей)

Использует Cloudflare D1 (SQLite) для хранения ключей.

## 📌 Структура файлов (что деплоить)

```
license-server/                ← это в вашем Git-репо
├── package.json                ← npm зависимости (только wrangler)
├── wrangler.toml               ← конфиг воркера + D1
├── schema.sql                  ← таблицы D1
├── seed.sql                    ← тестовые ключи (опц.)
├── admin_cli.js                ← CLI для управления ключами (локально)
├── src/
│   └── worker.js               ← код API
└── INTEGRATE_LICENSE.md        ← этот файл
```

**`admin_cli.js`** — НЕ деплоится в Cloudflare, он для вашего локального использования (запускаете с `node admin_cli.js`).

## 📌 Деплой — пошагово

### Шаг 1. Установить зависимости

```bash
cd license-server
npm install
```

Установится только `wrangler` (Cloudflare CLI).

### Шаг 2. Создать D1 базу данных

```bash
npx wrangler d1 create aeroopt-licenses
```

В ответ получите:
```
✅ Successfully created DB 'aeroopt-licenses' in region WEU
database_id = "abcd1234-ef56-..."
```

**Скопируйте `database_id`** и вставьте в `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "aeroopt-licenses"
database_id = "abcd1234-ef56-..."   # ← ВСТАВИТЬ СЮДА
```

### Шаг 3. Применить схему

```bash
npx wrangler d1 execute aeroopt-licenses --file=schema.sql
```

Это создаст таблицы: `licenses`, `activations`, `heartbeats`,
`stripe_events`, `revoked_tokens`, `admin_audit_log`.

### Шаг 4. (Опционально) Загрузить тестовые ключи

```bash
npx wrangler d1 execute aeroopt-licenses --file=seed.sql
```

Добавит 2 тестовых ключа:
- `AERO-TEST-0000-0000-0000-DEVEL` (5 машин, для разработки)
- `AERO-DEMO-1234-5678-9ABC-EDCBA` (2 машины, для демо)

### Шаг 5. Сгенерировать секреты

HMAC-ключ и admin-токен — 64 hex символа (32 байта). Генерация:

```bash
# Генерируем два разных ключа
openssl rand -hex 32   # это будет LICENSE_HMAC_KEY
openssl rand -hex 32   # это будет ADMIN_TOKEN
```

Задаём секреты в Cloudflare:

```bash
# HMAC-ключ (должен совпадать с AEROOPT_LICENSE_HMAC_KEY в .spec бинаря!)
echo "ваш_hmac_ключ_64_hex" | npx wrangler secret put LICENSE_HMAC_KEY

# Admin-токен (для admin_cli.js и админки на сайте)
echo "ваш_admin_токен_64_hex" | npx wrangler secret put ADMIN_TOKEN
```

Опционально (для email-отправки):

```bash
echo "re_xxxxxxxxxxxxxx" | npx wrangler secret put RESEND_API_KEY
echo "AeroOpt <noreply@aeroopt.app>" | npx wrangler secret put RESEND_FROM
```

### Шаг 6. Задеплоить

```bash
npx wrangler deploy
```

В ответ:
```
Total Worker Upload: 25.34 KiB
Uploaded aeroopt-license-server (1.50 sec)
Published aeroopt-license-server (0.50 sec)
  https://aeroopt-license-server.<ваш-subdomain>.workers.dev
```

**Готово!** API доступен на этом URL.

### Шаг 7. Проверить

```bash
# Healthcheck
curl https://aeroopt-license-server.<subdomain>.workers.dev/healthz

# Должно вернуть:
# {"ok":true,"server_ts":...,"data":{"status":"ok","version":"1.0.0"}}

# Попробовать активировать тестовый ключ
curl -X POST https://aeroopt-license-server.<subdomain>.workers.dev/v1/activate \
  -H "Content-Type: application/json" \
  -d '{"license_key":"AERO-TEST-0000-0000-0000-DEVEL","hwid":"test_hwid_1234567890abcdef"}'
```

## 📌 Настройка кастомного домена (опционально)

Если у вас есть домен `aeroopt.app` (или любой другой):

1. **Домен в Cloudflare**: добавьте `aeroopt.app` в Cloudflare (если ещё не добавлен)
2. **Worker → Triggers → Custom routes**:
   - Route: `api.aeroopt.app/*`
   - Service: `aeroopt-license-server`
3. **DNS** (Cloudflare сделает автоматически): появится CNAME `api.aeroopt.app → <subdomain>.workers.dev`

После этого API будет на `https://api.aeroopt.app`.

## 📌 Обновление клиентского кода (сделано)

В `license_checker.py`, `account/portal.js`, `admin/admin.js`,
`main_window.py` уже указан URL `https://api.aeroopt.app`.

**Если вы НЕ настраиваете кастомный домен**, переключитесь на workers.dev:
- В `license_checker.py`: замените `https://api.aeroopt.app` на `https://aeroopt-license-server.<subdomain>.workers.dev`
- Аналогично в других файлах

## 📌 Где что в бинаре

В `AeroOpt.spec` (PyInstaller spec) для приложения должны быть установлены переменные окружения:

```python
# В spec-файле:
env={
    'AEROOPT_LICENSE_SERVER': 'https://api.aeroopt.app',  # или workers.dev URL
    'AEROOPT_LICENSE_HMAC_KEY': 'тот_же_ключ_что_в_wrangler_secret',
}
```

Без этого бинарь не сможет связаться с сервером.

## 📌 Использование admin_cli.js (локально)

После деплоя воркера вы можете управлять ключами:

```bash
cd license-server
export ADMIN_TOKEN=ваш_admin_токен  # из wrangler secret put ADMIN_TOKEN

# Выдать ключ студенту
node admin_cli.js issue --email student@mit.edu --product edu --max-machines 1 --note "МФТИ, диплом"

# Список всех ключей
node admin_cli.js list

# Детали по ключу
node admin_cli.js inspect AERO-XXXX-XXXX-XXXX-XXXX

# Отозвать
node admin_cli.js revoke AERO-XXXX-XXXX-XXXX-XXXX --reason "возврат"

# Обновить примечание
node admin_cli.js note AERO-XXXX-XXXX-XXXX-XXXX --note "продлён до 2026"

# Снять отзыв
node admin_cli.js restore AERO-XXXX-XXXX-XXXX-XXXX
```

## 📌 Использование веб-админки (опционально)

Файл `site_v2/admin/index.html` задеплоен на Cloudflare Pages вместе с основным сайтом. Откройте `aeroopt.app/admin/`, введите ADMIN_TOKEN — увидите таблицу ключей с кнопками «отозвать», «восстановить», «изменить примечание», и форму выдачи.

## 📌 Деплой сайта (отдельно, через Cloudflare Pages)

См. `site_v2/README.md`. Краткий путь:

1. Создайте репозиторий на GitHub (например, `aeroopt-site`)
2. Залейте туда `fixes/site_v2/`
3. Cloudflare Dashboard → Pages → Connect to Git → выберите репо
4. Build settings:
   - Framework: None
   - Root directory: `/` (или `site_v2` если репо содержит и сервер)
   - Build command: (пусто)
   - Build output: `/`

## 📌 Структура Git-репозитория (если хотите всё в одном)

```
aeroopt-site/                  ← один Git
├── site/                       ← Cloudflare Pages
└── license-server/             ← Cloudflare Workers (через wrangler deploy)
```

Cloudflare Pages: указываете root = `site`.
License-сервер: `cd license-server && npx wrangler deploy` локально.

## 📌 Чек-лист после деплоя

- [ ] `npx wrangler d1 execute aeroopt-licenses --command='SELECT COUNT(*) FROM licenses'` возвращает число ключей
- [ ] `curl https://<ваш-воркер>.workers.dev/healthz` возвращает `{"status":"ok"}`
- [ ] `curl -X POST .../v1/activate` с тестовым ключом возвращает `{"ok":true, "token":...}`
- [ ] `node admin_cli.js list` показывает тестовые ключи
- [ ] В бинаре (`.spec` файл) установлены `AEROOPT_LICENSE_SERVER` и `AEROOPT_LICENSE_HMAC_KEY`
- [ ] После запуска бинаря, в меню «Лицензия → Активировать ключ» можно ввести `AERO-TEST-0000-0000-0000-DEVEL`

## 📌 Если что-то не работает

| Симптом | Решение |
|---|---|
| `wrangler: command not found` | `npm install` в `license-server/` |
| `d1 execute: database not found` | Сначала `wrangler d1 create aeroopt-licenses` |
| `Error: Authentication error` | Залогиньтесь: `npx wrangler login` (откроет браузер) |
| `worker.js > 1MB` | Cloudflare Workers бесплатно до 1MB на воркер, 10MB платно. У нас ~25KB, ОК |
| Воркер вернул 500 | Смотрите логи: `npx wrangler tail` |
| HMAC signature failed на клиенте | Убедитесь что `LICENSE_HMAC_KEY` в wrangler и `AEROOPT_LICENSE_HMAC_KEY` в `.spec` **совпадают** |
| `CORS` ошибка на сайте | Добавьте домен сайта в `ALLOWED_ORIGINS` в `src/worker.js` |

## 📌 Стоимость

- Cloudflare Workers: **бесплатно** до 100 000 запросов/день
- Cloudflare D1: **бесплатно** до 5 ГБ и 5 миллионов операций чтения/день
- Resend (email): **бесплатно** до 100 писем/день, 3000/месяц

Итого: **$0/мес** при <1000 активных пользователей.

## 📌 Следующие шаги (когда будете готовы)

1. **Stripe** — добавить обработку `checkout.session.completed` для автовыдачи ключей
2. **Email-шаблоны** — сейчас текст простой, можно сделать HTML-вёрстку
3. **Rate limit** — через KV (если будут абузы)
4. **Вебхуки мониторинга** — слать в Telegram/Slack когда выдан/отозван ключ
5. **Dashboard с графиками** — в админке: сколько ключей, распределение по продуктам, активные машины
