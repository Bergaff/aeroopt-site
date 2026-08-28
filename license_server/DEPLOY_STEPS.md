# Деплой и обновление license-сервера AeroOpt

> 🖱️ **Предпочтительный способ — без командной строки, только веб-интерфейсы
> Cloudflare/Stripe/Resend: см. [DEPLOY_DASHBOARD.md](./DEPLOY_DASHBOARD.md).**
> Ниже — тот же процесс через `wrangler` (терминал), как альтернатива.

Архитектура: **приложение AeroOpt → Cloudflare Worker → D1 (база лицензий)**.
Никакого публичного `licenses.json` в Git нет: ключи выдаются админкой на
сайте (или автоматически после оплаты Stripe) и хранятся только в D1.

---

## 1. Первичная установка (если воркер ещё не задеплоен)

```bash
cd license_server
npm install
npx wrangler login

# 1) база (database_id вставить в wrangler.toml)
npx wrangler d1 create aeroopt-licenses

# 2) схема
npx wrangler d1 execute aeroopt-licenses --file=schema.sql
#    тестовые ключи (опционально):
npx wrangler d1 execute aeroopt-licenses --file=seed.sql

# 3) секреты
#    LICENSE_HMAC_KEY — строго значение из раздела 3 ниже (оно зашито в клиент)!
npx wrangler secret put LICENSE_HMAC_KEY   # вставить 64-hex ключ, не генерировать новый
npx wrangler secret put ADMIN_TOKEN        # придумать длинный токен админки
#    (опц.) email и Stripe:
#    npx wrangler secret put RESEND_API_KEY
#    npx wrangler secret put RESEND_FROM
#    npx wrangler secret put STRIPE_WEBHOOK_SECRET

# 4) деплой
npx wrangler deploy
```

После деплоя воркер доступен на
`https://aeroopt-license-server.<ваш-subdomain>.workers.dev`
(сейчас в коде прописан `tgmg`).

## 2. Обновление уже работающего воркера (миграция 2026)

Если база создавалась по старой схеме (без `expires_at`, `features` и
`activations.revoked_at`) — выполните миграцию на БОЕВОЙ базе:

```bash
cd license_server
npx wrangler d1 execute aeroopt-licenses --remote --file=migrate_2026.sql
npx wrangler deploy
```

> D1 не поддерживает `ADD COLUMN IF NOT EXISTS`: если колонка уже есть,
> wrangler покажет ошибку «duplicate column name» на соответствующем
> ALTER и продолжит со следующего оператора — это нормально.

## 3. Секрет LICENSE_HMAC_KEY и десктоп-клиент

Подпись ответов сервера проверяется в приложении встроенным HMAC-ключом.
Они ДОЛЖНЫ совпадать:

- сервер: `npx wrangler secret put LICENSE_HMAC_KEY` → введите 64 hex;
- приложение: тот же ключ зашит в
  `desktop_client/license_client/license_checker.py`
  (XOR-обфускация, метод `_decode_hmac_key`).

Текущий ключ сборки 4.1.0 (64 hex):

```
7d7a18a6632e3ef6f0a933e83bb4b5c48092b39718ea106554e4b870d04f2eaf
```

Если ротируете ключ — задайте его в секрете воркера И пересоберите
приложение с новым обфусцированным значением (см. INTEGRATE_LICENSE.md,
раздел «Ротация HMAC-ключа»).

При сборке через PyInstaller можно также передавать URL и ключ
переменными окружения (они имеют приоритет над встроенными):

```
AEROOPT_LICENSE_SERVER = https://aeroopt-license-server.tgmg.workers.dev
AEROOPT_LICENSE_HMAC_KEY = <64 hex>
```

## 4. Проверка после деплоя

```bash
curl https://aeroopt-license-server.tgmg.workers.dev/healthz
# {"ok":true,...,"status":"ok","version":"4.1.0"}

# активация демо-ключа (после миграции он есть в базе):
curl -X POST https://aeroopt-license-server.tgmg.workers.dev/v1/activate \
  -H "Content-Type: application/json" \
  -d '{"license_key":"AERO-DEMO-2026-TEST","hwid":"0123456789abcdef0123456789abcdef","app_version":"4.1.0"}'
# → {"ok":true,"status":"active",...,"signature":"..."}
```

## 5. Кастомный домен api.aeroopt.app (опционально)

Cloudflare Dashboard → Workers → Triggers → Custom routes →
`api.aeroopt.app/*`. Затем поменять `DEFAULT_URL` в
`desktop_client/license_client/license_checker.py` и `API_BASE`
в `site/admin/admin.js`, `site/account/portal.js` на `https://api.aeroopt.app`.

## 6. Управление ключами

- Веб-админка: `https://<сайт>/admin/` → вход по `ADMIN_TOKEN`
  (кнопка «Выдать ключ», список, отзыв, примечания, срок действия).
- CLI (Node):  `cd license_server && ADMIN_TOKEN=... node admin_cli.js ...`
- CLI (Python, на машине без Node):
  `set ADMIN_TOKEN=... && python ..\generate_license.py issue --email x@x --product pro`
- После оплаты Stripe ключ создаётся автоматически (см. ниже).

## 7. Stripe — автоматическая выдача при покупке

1. Stripe Dashboard → Products: создать Personal ($99) и Pro ($299),
   в метаданных продукта/цены (или Checkout Session) указать
   `product=personal` / `product=pro`.
2. Developers → Webhooks → Add endpoint:
   - URL: `https://aeroopt-license-server.tgmg.workers.dev/v1/stripe_webhook`
   - Events: `checkout.session.completed`
3. Подписать секрет (`whsec_...`):
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. Ссылки «Купить» на сайте (сейчас заглушки `buy.stripe.com/YOUR_...`)
   заменить на реальные Payment Links из Stripe.

После оплаты воркер сам создаёт ключ в D1 и (если задан Resend) шлёт
его покупателю на почту. События Stripe идемпотентны — повторная
доставка вебхука не создаёт дублей.
