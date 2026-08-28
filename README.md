# Сайт AeroOpt — структура и деплой

## 📌 Где какие файлы

```
site_v2/
├── index.html              # Главная страница
├── style.css               # Стили (плоские, тёплые, без украшений)
├── account/
│   ├── index.html          # Личный кабинет (вход + dashboard)
│   └── portal.js           # Логика кабинета (vanilla JS, без зависимостей)
├── legal/
│   ├── terms.html          # ToS (Условия использования)
│   └── privacy.html        # Privacy Policy (Политика конфиденциальности)
└── docs/
    ├── quickstart.html
    ├── mesh.html
    ├── gpu.html
    ├── optimization.html
    └── troubleshooting.html
```

## 📌 Деплой через Git + Cloudflare Pages (рекомендуется)

### 1. Создайте репозиторий

На [github.com](https://github.com) (или GitLab) создайте приватный репозиторий `aeroopt-site`.

### 2. Залейте сайт

```bash
cd site_v2
git init
git add .
git commit -m "Initial commit: AeroOpt site v2"
git branch -M main
git remote add origin https://github.com/ВАШ_ЮЗЕРНЕЙМ/aeroopt-site.git
git push -u origin main
```

### 3. Подключите к Cloudflare Pages

1. Откройте [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Workers & Pages → Create application → Pages → Connect to Git
3. Выберите репозиторий `aeroopt-site`
4. Build settings:
   - Framework preset: None
   - Build command: (пусто)
   - Build output directory: `/`
5. Save and Deploy

Через 1-2 минуты сайт будет доступен на `https://aeroopt-site.pages.dev`.

### 4. Кастомный домен

Купите домен (например, `aeroopt.app` на Namecheap за $15-30/год).

В Cloudflare Pages:
- Custom domains → Set up a custom domain → введите `aeroopt.app`
- Cloudflare автоматически настроит DNS.

Дополнительные поддомены:
- `aeroopt.app` — главная
- `account.aeroopt.app` — личный кабинет (отдельный Pages-проект или path)
- `docs.aeroopt.app` — документация (опц.)

## 📌 Альтернатива: деплой без Git (R2 bucket)

Если не хотите Git:

```bash
# Установите wrangler
npm install -g wrangler

# Создайте R2 bucket
npx wrangler r2 bucket create aeroopt-site
npx wrangler r2 bucket put aeroopt-site legal/terms.html --file=legal/terms.html
# ... для каждого файла

# Подключите кастомный домен через R2 Custom Domain
```

Недостаток: нет автодеплоя. Каждое обновление — ручная загрузка.

## 📌 Настройка лицензионного сервера

Сайт и десктоп-приложение работают с Cloudflare Worker + D1:
`https://aeroopt-license-server.tgmg.workers.dev`
(планируется кастомный домен `api.aeroopt.app`).

Ключи хранятся ТОЛЬКО в базе D1 — публичного `licenses.json` в репозитории
больше нет. Выдача ключей:

- админка на сайте (`/admin/`, вход по `ADMIN_TOKEN`);
- CLI: `node license_server/admin_cli.js ...` или
  `python generate_license.py issue --email ... --product pro`;
- автоматически после оплаты Stripe (вебхук).

Полная инструкция по деплою, миграции боевой базы и HMAC-секрету:
[`license_server/DEPLOY_STEPS.md`](license_server/DEPLOY_STEPS.md).
Справочник API: [`license_server/INTEGRATE_LICENSE.md`](license_server/INTEGRATE_LICENSE.md).
Интеграция в десктоп: [`desktop_client/README_INTEGRATION.md`](desktop_client/README_INTEGRATION.md).

Если URL воркера изменится — поправьте `API_BASE` в `site/account/portal.js`
и `site/admin/admin.js`, а также `DEFAULT_URL` в
`desktop_client/license_client/license_checker.py`.

## 📌 Скачивание бинарников (через Google Drive)

Сейчас ссылки на скачивание ведут на Google Drive. Это самый простой
вариант — не нужно поднимать R2 или CDN, и работает для файлов любого
размера (Drive поддерживает файлы до 5 ТБ).

### Как получить прямую ссылку

1. Залейте `.exe` или `.tar.gz` на Google Drive (через веб-интерфейс).
2. Откройте файл. В адресной строке будет что-то вроде:
   ```
   https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view
   ```
3. Скопируйте ID файла — это длинная строка между `/d/` и `/view`:
   ```
   1AbCdEfGhIjKlMnOpQrStUvWxYz
   ```
4. Прямая ссылка для скачивания имеет формат:
   ```
   https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz
   ```
5. Вставьте её в `index.html` вместо плейсхолдера
   `1AbCdEfGhIjKlMnOpQrStUvWxYz_WINDOWS_FILE_ID`.

### Настройка публичного доступа

Чтобы ссылка работала, файл должен быть доступен по ссылке
("Все, у кого есть ссылка"). Google Drive по умолчанию делает
файлы приватными, поэтому:

1. Правый клик на файл → "Открыть доступ"
2. Выберите "Все, у кого есть ссылка"
3. Роль: "Читатель" (Viewer) — этого достаточно для скачивания
4. Нажмите "Готово"

### Для больших файлов (больше 100 МБ)

Google Drive для файлов больше 100 МБ показывает промежуточную
страницу с кнопкой "Скачать в любом случае" — это антивирусная
проверка. Чтобы её обойти, есть трюк:

```
https://drive.google.com/uc?export=download&confirm=t&id=FILE_ID
```

Параметр `confirm=t` сообщает Drive, что пользователь уже подтвердил
скачивание (обходит проверку на вирусы для доверенных файлов).
Используйте эту форму для бинарников, которые вы сами собрали.

### Альтернатива: GitHub Releases

Если Google Drive покажется неудобным, можно использовать
GitHub Releases — он даёт прямые ссылки на файлы аттачей:

1. Создайте релиз на GitHub (на странице репо → Releases → New release)
2. Загрузите `.exe` и `.tar.gz` как binary attachments
3. Прямая ссылка выглядит так:
   ```
   https://github.com/USER/REPO/releases/download/v4.1.0/aeroopt-4.1.0-win64.exe
   ```
4. Эта ссылка работает без промежуточных страниц, скачивание идёт
   с CDN GitHub (быстро).

## 📌 Личный кабинет и сервер

В `account/portal.js` используется endpoint `/v1/account_info`, которого ещё нет в `license_server/src/worker.js`.

**Добавьте его** в воркер:

```javascript
if (path === '/v1/account_info' && req.method === 'POST') {
    return await handleAccountInfo(req, env);
}

async function handleAccountInfo(req, env) {
    const body = await req.json().catch(() => null);
    if (!body?.license_key) return err('bad_request', 'license_key required');
    const license = await env.DB.prepare(
        'SELECT license_key, email, product, expires_at, max_hwid_count ' +
        'FROM licenses WHERE license_key = ?'
    ).bind(body.license_key).first();
    if (!license) return err('not_found', 'License not found', 404);
    const activations = await env.DB.prepare(
        'SELECT hwid, hostname, os, app_version, first_seen, last_seen, is_active ' +
        'FROM activations WHERE license_key = ? ORDER BY last_seen DESC'
    ).bind(body.license_key).all();
    const heartbeats = await env.DB.prepare(
        'SELECT ts, app_version, runs_count FROM heartbeats ' +
        'WHERE license_key = ? AND ts > ? ORDER BY ts DESC LIMIT 50'
    ).bind(body.license_key, Math.floor(Date.now() / 1000) - 30 * 86400).all();
    return ok({
        license: {
            key: license.license_key,
            product: license.product,
            expires_at: license.expires_at,
            hwid_max: license.max_hwid_count,
        },
        activations: activations.results,
        heartbeats: heartbeats.results,
    });
}
```

**Также добавьте CORS-разрешения** для вашего домена (если сайт и API на разных поддоменах):

В `worker.js` в начало `fetch()`:
```javascript
const origin = req.headers.get('Origin') || '';
const allowed = ['https://aeroopt.app', 'https://www.aeroopt.app', 'http://localhost:8788'];
if (allowed.includes(origin)) {
    CORS_HEADERS['Access-Control-Allow-Origin'] = origin;
}
```

## 📌 Stripe (когда будете готовы)

В `index.html` кнопки «Купить Personal» и «Купить Pro» ведут на `https://buy.stripe.com/YOUR_PERSONAL_LINK` — это placeholder.

**Что нужно сделать:**
1. Создайте в Stripe Dashboard три продукта (Personal $99, Pro $299, Educational $0)
2. Для каждого создайте Payment Link (Stripe генерирует URL вида `https://buy.stripe.com/...`)
3. В `index.html` замените `YOUR_PERSONAL_LINK` и `YOUR_PRO_LINK` на реальные ссылки
4. Настройте webhook в Stripe на ваш `license_server` (см. `DEPLOY_LICENSE.md`)

## 📌 Проверка перед запуском

Откройте `index.html` локально в браузере — все страницы работают без сервера, кроме личного кабинета (ему нужен запущенный `license_server`).

Чек-лист:
- [ ] Все ссылки на страницах работают
- [ ] Формы в личном кабинете не падают
- [ ] Скачивание бинарников работает (если залили в R2)
- [ ] Stripe-кнопки ведут на реальные checkout-ссылки
- [ ] License-сервер отвечает на `/v1/account_info`
- [ ] `API_BASE` в `portal.js` указывает на правильный URL

## 📌 Стоимость

- Cloudflare Pages: **бесплатно** (unlimited bandwidth)
- Cloudflare Workers + D1: **бесплатно** до 100K req/day и 5GB
- Кастомный домен: $10-30/год (зависит от TLD)
- Stripe: 2.9% + $0.30 за транзакцию

Итого: **$10-30/год** + комиссия Stripe.
