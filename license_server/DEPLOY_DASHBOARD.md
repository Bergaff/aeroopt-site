# Деплой лицензионного сервера ТОЛЬКО через веб-интерфейсы (без терминала)

Всё делается кликами в браузере: Cloudflare Dashboard, Stripe Dashboard,
Resend Dashboard. Командная строка не нужна ни на одном шаге.

---

## Шаг 1. Обновить базу D1

База у вас уже есть. В D1 нет кнопки «импорт файла» — SQL просто
вставляется в редактор и выполняется.

1. [Cloudflare Dashboard](https://dash.cloudflare.com) →
   **Workers & Pages** → слева **D1 SQL Database** → откройте свою базу.
2. Вкладка **Console** (SQL-редактор в браузере).
3. **Сначала проверьте структуру** — выполните запрос:
   ```sql
   SELECT name FROM pragma_table_info('licenses');
   ```
   - Если в ответе есть `expires_at` и `features` — база уже мигрирована,
     перейдите к проверке демо-ключа (пункт 5).
   - Если их нет — нужна миграция (пункт 4).
4. Вставьте в Console и выполните блок ниже **по одному оператору**
   (после каждого жмите Execute; ошибки «duplicate column name» — это
   нормально, значит колонка уже существует):
   ```sql
   ALTER TABLE licenses ADD COLUMN expires_at INTEGER;
   ```
   ```sql
   ALTER TABLE licenses ADD COLUMN features TEXT;
   ```
   ```sql
   ALTER TABLE activations ADD COLUMN revoked_at TEXT;
   ```
   ```sql
   INSERT OR IGNORE INTO licenses
       (license_key, plan, max_machines, customer_email, note,
        expires_at, features, created_at, updated_at)
   VALUES
       ('AERO-DEMO-2026-TEST', 'pro', 2, 'demo@aeroopt.app',
        'Демо-ключ для проверки связи (публичный)',
        1830211200,
        '["basic","sweep","optimization","rans","gpu"]',
        datetime('now'), datetime('now'));
   ```
   (`1830211200` — это 31 декабря 2027; INSERT с `OR IGNORE` не создаст
   дублей при повторном выполнении.)
5. Проверка — выполните в Console:
   ```sql
   SELECT license_key, plan, max_machines, expires_at FROM licenses;
   ```
   В списке должна быть строка `AERO-DEMO-2026-TEST | pro | 2 | 1830211200`.

## Шаг 2. Задеплоить код воркера

Воркер у вас уже создан. Есть два способа обновлять код.

### Вариант А (рекомендуется): автодеплой из GitHub

В настройках воркера уже подключён Git-репозиторий. Чтобы сборка
перестала падать с ошибкой **«root directory not found»**, на вкладке
воркера **Settings → Builds → Build configuration** укажите:

| Поле | Значение |
|---|---|
| Root directory | `license_server` (БЕЗ ведущего слэша! `/license_server` — ошибка) |
| Build command | (оставить пустым) |
| Deploy command | `npx wrangler deploy` |

> Важно: в интерфейсе у вас сейчас стоит deploy command
> `npx wrangler versions upload` и Root directory, похоже, со слэшем —
> именно поэтому сборка падает. Поправьте Root directory на
> `license_server`, Deploy command — на `npx wrangler deploy`
> (или вообще очистите deploy/build команды — при Root directory
> `license_server` Cloudflare сам найдёт `wrangler.toml` и задеплоит).
> Production branch: `arena/01a04770-aeroopt-site` (уже стоит правильно).

Перед этим проверьте ID базы: откройте свою D1 базу в дашборде,
скопируйте её Database ID и убедитесь, что в
[`wrangler.toml`](./wrangler.toml) в строке `database_id` стоит то же
значение. Сейчас там `7e7359a3-b7b1-44f0-a364-a79db69d3386` — если ID
вашей базы другой, скажите мне, я поправлю (или поменяйте сами в файле
и запушьте — сборка подхватит).

После сохранения настроек нажмите **Retry build** (или сделайте любой
пустой коммит) — сборка должна пройти. При деплое из Git D1-биндинг
`DB` подхватится автоматически из `wrangler.toml`, ручная привязка
(шаг 3) не нужна. Секреты, заданные в дашборде (ADMIN_TOKEN,
LICENSE_HMAC_KEY, APP_VERSION), при Git-деплое НЕ сбрасываются.

### Вариант Б (без Git): вставить код вручную

1. Нажмите **Edit code**. Удалите весь код-заглушку в редакторе.
2. Откройте файл [`src/worker.js`](./src/worker.js), скопируйте всё
   содержимое, вставьте в редактор → **Deploy**.
3. Node-совместимость (воркер использует `node:crypto`):
   Worker → **Settings → Compatibility Flags** → добавить
   `nodejs_compat` (у вас уже включено ✅). Compatibility date —
   оставить `2024-09-01`.

## Шаг 3. Привязать базу к воркеру

- Если деплоили **через GitHub** (вариант А) — ничего делать не нужно:
  привязка D1 `DB` берётся из `wrangler.toml`.
- Если деплоили **вставкой кода** (вариант Б): Worker → **Settings** →
  **Bindings** → **Add binding** → тип **D1 database**. Variable name:
  **`DB`** (заглавными) → выберите базу `aeroopt-licenses` →
  **Save and deploy**.

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

После добавления переменных Cloudflare сам передеплоит воркер
(или нажмите **Deploy**).

> `LICENSE_HMAC_KEY` — тот же ключ, что зашит в десктоп-клиент.
> Если смените его — придётся пересобирать приложение (см.
> `../desktop_client/README_INTEGRATION.md`), поэтому используйте
> указанное значение.
>
> Секрет для платёжного вебхука сейчас НЕ нужен: онлайн-оплата временно
> отключена (кнопки «Купить» на сайте ведут на sales@aeroopt.app), ключи
> выдаются вручную в админке. Код авто-выдачи после оплаты в воркере
> уже есть (`/v1/stripe_webhook`) — он «спящий», без секрета просто не
> срабатывает; подключим, когда выберете платёжную систему.

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

## Шаг 6. Платежи — сейчас заглушка (покупка через email)

Онлайн-оплата пока отключена. На сайте кнопки «Купить Personal / Pro»
ведут на `mailto:sales@aeroopt.app`. Рабочий процесс:

1. Покупатель пишет на sales@aeroopt.app.
2. Вы открываете `/admin/`, входите по `ADMIN_TOKEN`, жмёте **«Выдать
   ключ»**, выбираете продукт (`personal`/`pro`) и указываете email
   покупателя.
3. Если настроен Resend (шаг 7) — ключ уходит письмом автоматически;
   если нет — копируете ключ из списка и отправляете вручную.

Задел на будущее: в воркере уже реализован вебхук авто-выдачи ключа
после оплаты (`/v1/stripe_webhook`, идемпотентный). Когда выберете
платёжную систему — этот маршрут адаптируется под неё; сейчас он без
секрета `STRIPE_WEBHOOK_SECRET` просто отвечает 400 и ни на что не
влияет.

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
