# License Server API — справочник (AeroOpt 4.1)

Cloudflare Worker + D1. Базовый URL:
`https://aeroopt-license-server.tgmg.workers.dev`
(планируется `https://api.aeroopt.app`).

- Деплой и миграции: см. [`DEPLOY_STEPS.md`](./DEPLOY_STEPS.md).
- Интеграция в десктоп-клиент: см.
  [`../desktop_client/README_INTEGRATION.md`](../desktop_client/README_INTEGRATION.md).
- Все ответы — JSON `{ok: true/false, ...}`; ответы клиентских
  эндпоинтов подписаны HMAC-SHA256 (поле `signature`, см. ниже).

## Эндпоинты клиента (десктоп)

### POST /v1/activate
Привязка HWID к ключу (или ответ уже существующей активации).

Запрос:
```json
{ "license_key": "AERO-XXXX-...", "hwid": "<sha256 hex>",
  "app_version": "4.1.0", "hostname": "...", "os": "Windows 11" }
```
Ответ (подписан):
```json
{ "ok": true, "status": "active", "license_key": "...", "hwid": "...",
  "product": "pro", "plan": "pro",
  "expires_at": 0, "grace_until": 0, "offline_until": 173...,
  "hwid_count": 1, "hwid_max": 3,
  "features": ["basic","sweep","optimization","rans","gpu"],
  "token": "<run token>", "server_ts": 173..., "signature": "<hmac hex>" }
```
Ошибки: `invalid_key` (404), `revoked` (403), `expired` (403),
`hwid_limit` (403 — занято больше машин, чем разрешено).

### POST /v1/heartbeat
Периодическая проверка (раз в ~30 дней). Тело — как activate.
Ответ — тот же подписанный набор полей; `token` ротируется.
Ошибки: те же + `not_bound` (HWID не привязан к этому ключу),
`deactivated` (активация отозвана деактивацией/админом).

### POST /v1/run_token
Выдача/проверка токена перед расчётом. Тело: `{license_key, hwid,
token}` (token — последний известный клиенту).
Ответ: `{ok: true, token: "...", ...подписанные поля...}`.
Ошибка `bad_token` (403) — клиент должен сделать heartbeat.

### POST /v1/deactivate
Отвязка машины (освобождает слот): `{license_key, hwid, token}` →
`{ok: true, deactivated: true}`. Работает и без сети на стороне
клиента (локальная отвязка).

### GET /healthz
`{ok: true, db: "ok"|..., version: "4.1.0"}` — без подписи.

## Подпись ответов (HMAC)

Подписываются поля:
`status, license_key, hwid, product, plan, expires_at, grace_until,
offline_until, hwid_count, hwid_max, features, token, server_ts`.

Канонический JSON — компактный, ключи рекурсивно отсортированы,
не-ASCII не экранируется (Python: `json.dumps(..., sort_keys=True,
separators=(",",":"), ensure_ascii=False)`), затем
`HMAC-SHA256(secret, canonical).hexdigest()`. Реализации:
JS — `hmac()` в `src/worker.js`, Python — `_canonical()`/
`_verify_response_signature()` в
`desktop_client/license_client/license_checker.py`.

## Эндпоинты админа (заголовок `X-Admin-Token: <ADMIN_TOKEN>`)

| Метод/путь | Назначение |
|---|---|
| `POST /v1/admin/issue` | Выдать ключ. Тело: `{email, product: personal\|pro\|edu\|trial, max_machines?, expires_in_days?, note?}`. Сервер генерирует ключ, пишет в D1, шлёт email (Resend, если настроен). |
| `GET  /v1/admin/list?product=&active_only=&limit=&offset=&q=` | Список лицензий с числом активаций. |
| `GET  /v1/admin/inspect?license_key=` | Карточка ключа: активации, heartbeat'ы, audit log. |
| `POST /v1/admin/revoke` | `{license_key, reason?}` — отзыв; активации деактивируются. |
| `POST /v1/admin/restore` | `{license_key}` — снять отзыв (`revoked_at = NULL`). |
| `POST /v1/admin/set_note` | `{license_key, note}` — примечание. |

### POST /v1/account_info
Тело: `{email}` или `{license_key, hwid}` — данные для личного
кабинета на сайте (ключ, план, машины, срок). Без подписи (используется
сайтом, не десктопом).

### POST /v1/check_update
Проверка новой версии приложения (сверка с `APP_VERSION`).

CLI: `node admin_cli.js issue --email x@x --product pro`
или Python `python generate_license.py issue ...` (из корня репо).

## Платежи (сейчас заглушка, на будущее)

Онлайн-оплата временно отключена: кнопки «Купить» на сайте ведут на
`mailto:sales@aeroopt.app`, ключи выдаются вручную через админку.
Задел для авто-выдачи: `POST /v1/stripe_webhook` (событие
`checkout.session.completed`, проверка подписи по
`STRIPE_WEBHOOK_SECRET`, план из metadata сессии `product=personal|pro`,
идемпотентность по event id в таблице `stripe_events`). Без секрета
маршрут отвечает 400 и ни на что не влияет.
