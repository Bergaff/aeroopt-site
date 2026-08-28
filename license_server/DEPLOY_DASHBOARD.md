# Деплой лицензионного сервера ТОЛЬКО через веб-интерфейсы (без терминала)

Всё делается кликами в браузере: Cloudflare Dashboard, Stripe Dashboard,
Resend Dashboard. Командная строка не нужна ни на одном шаге.

---

## Шаг 1. Создать базу D1

1. Зайдите в [Cloudflare Dashboard](https://dash.cloudflare.com) →
   **Workers & Pages** → слева **D1 SQL Database** → **Create database**.
2. Имя: `aeroopt-licenses` → **Create**.
3. Откройте базу → вкладка **Console** (SQL-редактор).
4. Если база НОВАЯ (пустая): откройте файл
   [`schema.sql`](./schema.sql) из репозитория, скопируйте всё
   содержимое, вставьте в Console → **Execute**.
5. Если база УЖЕ существовала (старая схема): скопируйте и выполните
   содержимое [`migrate_2026.sql`](./migrate_2026.sql) — он добавит
   недостающие колонки и демо-ключ. Ошибки «duplicate column name»
   в ответе на ALTER — нормально (колонка уже есть), данные целы.
6. Проверка — выполните в Console:
   ```sql
   SELECT license_key, plan, max_machines, expires_at FROM licenses;
   ```
   Должна быть видна строка `AERO-DEMO-2026-TEST | pro | 2 | 1830211200`.

## Шаг 2. Создать Worker

1. **Workers & Pages** → **Create application** → **Create Worker**.
2. Имя: `aeroopt-license-server` → **Deploy** (пока задеплоится заглушка —
   это нормально).
3. Нажмите **Edit code** (или **Edit Worker**). Удалите весь код-заглушку
   в редакторе.
4. Откройте файл [`src/worker.js`](./src/worker.js) из репозитория,
   скопируйте всё содержимое и вставьте в редактор → **Deploy**.
5. Включить Node-совместимость (воркер использует `node:crypto`):
   Worker → **Settings** → раздел **Compatibility Flags** →
   добавить флаг `nodejs_compat` → Save.
   (Compatibility date можно оставить по умолчанию.)

## Шаг 3. Привязать базу к воркеру

1. Worker → **Settings** → **Bindings** (или **Variables and Secrets**)
   → **Add binding** → тип **D1 database**.
2. Variable name: **`DB`** (заглавными, именно так) → выберите базу
   `aeroopt-licenses` → **Save and deploy**.

## Шаг 4. Задать секреты

Worker → **Settings** → **Variables and Secrets** → добавьте
(тип **Secret** для токенов, значение скрыто после сохранения):

| Имя переменной | Значение | Тип |
|---|---|---|
| `LICENSE_HMAC_KEY` | `7d7a18a6632e3ef6f0a933e83bb4b5c48092b39718ea106554e4b870d04f2eaf` | Secret |
| `ADMIN_TOKEN` | придумайте длинный пароль (им же входить в /admin/) | Secret |
| `APP_VERSION` | `4.1.0` | Text |
| `RESEND_API_KEY` | ключ из Resend (шаг 7, можно позже) | Secret |
| `RESEND_FROM` | адрес отправителя, напр. `AeroOpt <licenses@aeroopt.app>` | Text |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` из Stripe (шаг 6) | Secret |

После добавления переменных Cloudflare сам передеплоит воркер
(или нажмите **Deploy**).

> `LICENSE_HMAC_KEY` — тот же ключ, что зашит в десктоп-клиент.
> Если смените его — придётся пересобирать приложение (см.
> `../desktop_client/README_INTEGRATION.md`), поэтому используйте
> указанное значение.

## Шаг 5. Проверить, что всё работает

Откройте в браузере (или нажмите на выданный воркер-URL):

```
https://aeroopt-license-server.<ваш-сабдомен>.workers.dev/healthz
```

Должно вернуться: `{"ok":true,"status":"ok","version":"4.1.0"}`.

Дальше откройте админку сайта (страница `/admin/`) и войдите по
`ADMIN_TOKEN`: выдайте тестовый ключ кнопкой **«Выдать ключ»** —
он сразу появится в списке и в D1 (можно перепроверить SQL-запросом
из шага 1.6).

Если воркер разворачивался под именем `aeroopt-license-server` в том же
аккаунте, URL уже совпадает с зашитым в клиент
(`aeroopt-license-server.tgmg.workers.dev` — сабдомен `tgmg`).
Если сабдомен другой — поправьте адрес в трёх местах:
`site/admin/admin.js`, `site/account/portal.js` (константа `API_BASE`)
и `desktop_client/license_client/license_checker.py` (`DEFAULT_URL`).

## Шаг 6. Stripe — автоматическая выдача ключей после оплаты

1. [Stripe Dashboard](https://dashboard.stripe.com) → **Products** →
   создайте Personal и Pro (цены по вашей тарифной сетке).
2. При создании **Payment Link** (или Checkout Session) в поле
   метаданных укажите: `product` = `pro` (или `personal`).
   Именно по этому полю воркер определит, какой ключ выдать.
3. **Developers → Webhooks → Add endpoint**:
   - Endpoint URL:
     `https://aeroopt-license-server.<сабдомен>.workers.dev/v1/stripe_webhook`
   - Events to send: `checkout.session.completed`
   - После создания скопируйте **Signing secret** (`whsec_...`).
4. Вставьте его в секрет `STRIPE_WEBHOOK_SECRET` (шаг 4).
5. Ссылки «Купить» на сайте замените на Payment Links из Stripe.

После оплаты воркер сам создаст ключ в D1 и отправит письмо покупателю
(если настроен Resend). Повторная доставка вебхука дублей не создаёт.

## Шаг 7. (Опционально) Email с ключом через Resend

1. [Resend Dashboard](https://resend.com) → **API Keys** → создайте ключ
   `re_...`.
2. Подтвердите домен отправителя (**Domains** → добавьте `aeroopt.app`
   и пропишите DNS-записи, которые покажет Resend), либо на старте
   можно использовать тестовый `onboarding@resend.dev`.
3. Вставьте `RESEND_API_KEY` и `RESEND_FROM` в секреты воркера (шаг 4).
   Без них ключи выдаются и работают, но письмо не отправляется —
   ключ видно в админке.

## Шаг 8. (Опционально) Кастомный домен api.aeroopt.app

1. Cloudflare → ваш воркер → **Settings** → **Domains & Routes** →
   **Add Custom Domain** → `api.aeroopt.app` (домен должен быть в том
   же Cloudflare-аккаунте; DNS-записи Cloudflare подставит сам).
2. После активации домена поменяйте адрес на `https://api.aeroopt.app`
   в `API_BASE` (admin.js, portal.js) и `DEFAULT_URL`
   (license_checker.py) и пересоберите приложение.

---

### Выдать ключ вручную без админки (если нужно)

D1 Console базы `aeroopt-licenses`, пример для pro-ключа на 3 машины,
бессрочного (ключ замените на сгенерированный в стиле AERO-XXXX-…):

```sql
INSERT INTO licenses
  (license_key, plan, max_machines, customer_email, email, note,
   expires_at, features, created_at, updated_at)
VALUES
  ('AERO-XXXX-XXXX-XXXX-XXXX', 'pro', 3, 'buyer@example.com',
   'buyer@example.com', 'выдан вручную',
   NULL, '["basic","sweep","optimization","rans","gpu"]',
   datetime('now'), datetime('now'));
```

`trial` — план `trial`, `max_machines` 1, `expires_at` =
`CAST(strftime('%s','now') AS INTEGER) + 14*86400`.
Но проще и правильнее — кнопкой «Выдать ключ» в админке: она и ключ
сгенерирует, и письмо отправит.
