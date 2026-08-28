# Обновление десктопного AeroOpt до лицензий 4.1 — пошагово

Формат: маленькие файлы — заменить целиком; в остальном коде приложения
**ничего менять не нужно** (публичный API клиента сохранён 1-в-1).

## 1. Заменить папку лицензий

**УДАЛИТЬ** старую папку `license_client/` целиком (там были
`license_checker.py`, `rsa_helpers.py`, `local_decrypt.py`, `public.pem`
и прочее — всё это больше не нужно: подпись ответов делается HMAC,
ключи лежат в Cloudflare D1, а не в публичном JSON).

**ВСТАВИТЬ** новую папку из репозитория:

```
desktop_client/
├── license_client/
│   ├── __init__.py
│   └── license_checker.py
└── diagnose_license.py          ← положить в корень проекта AeroOpt
```

Итоговое расположение в проекте приложения:

```
AeroOpt/
├── main.py
├── ui/main_window.py            ← БЕЗ изменений
├── license_client/              ← НОВАЯ (2 файла)
│   ├── __init__.py
│   └── license_checker.py
└── diagnose_license.py          ← НОВЫЙ (опционально, диагностика)
```

## 2. Что НЕ меняется в коде приложения

Эти вызовы уже есть в `ui/main_window.py` / `main.py` и работают
с новым клиентом без правок:

| Где | Вызов | Совместимость |
|---|---|---|
| старт приложения | `checker.bootstrap()` | ✅ сигнатура та же |
| меню «Активировать ключ» | `checker.activate(key)` → `(bool, str)` | ✅ |
| меню «Статус лицензии» | `checker.get_status_text()` / `heartbeat()` | ✅ |
| меню «Отвязать машину» | `checker.deactivate()` | ✅ |
| гейт перед расчётом | `checker.is_calculation_allowed()` → `(bool, reason)` | ✅ |
| гейт внутри расчёта | `checker.acquire_run_token()` → `(bool, str)` | ✅ |
| `LicenseStatus.ACTIVE/EXPIRED/NO_KEY/...` | сравнения статусов | ✅ (+ алиасы TRIAL/REVOKED/HWID_LIMIT) |

## 3. Удалить из сборки/проекта старое

- `license_client/rsa_helpers.py`, `license_client/local_decrypt.py`,
  `license_client/public.pem`, `license_client/licenses.json` (если лежал
  локально) — больше не используются, удалить.
- Если в `main.py`/`ui/*.py` есть импорты вида
  `from license_client.rsa_helpers import ...` или
  `from license_client.local_decrypt import ...` — удалить эти строки
  (новый клиент самодостаточен: только stdlib — `urllib`, `hmac`,
  `hashlib`, `json`, `ctypes`).

## 4. Проверить после замены

1. `python -c "from license_client import LicenseChecker; c=LicenseChecker(); print(c.get_status_text())"`
   → «🔑 Лицензия не активирована» (без ошибок импорта).
2. Запуск приложения без ключа → расчёт заблокирован, меню «Лицензия» работает.
3. Активировать демо-ключ **AERO-DEMO-2026-TEST** (он уже в боевой D1,
   план pro, до 2027-12-31) → статус «✅ Лицензия активна · pro»,
   RANS/GPU доступны.
4. Закрыть приложение, выключить сеть, открыть снова → работает
   (офлайн-кэш `~/.aeroopt/license.dat`).
5. `python diagnose_license.py` → в отчёте «Подпись ответа сервера: ВЕРНА».

## 5. Если что-то не сходится

- «Подпись НЕ СОВПАЛА» в диагностике → на воркере задан другой
  `LICENSE_HMAC_KEY`. Должен быть:
  `7d7a18a6632e3ef6f0a933e83bb4b5c48092b39718ea106554e4b870d04f2eaf`
  (проверить/задать в Cloudflare Dashboard: Worker → Settings →
  Variables and Secrets → `LICENSE_HMAC_KEY`; см.
  `license_server/DEPLOY_DASHBOARD.md`, шаг 4).
- «hwid_limit» при активации → отвязать старую машину в личном кабинете
  на сайте (`/account/`) или деактивировать на старом ПК.
- Переопределить сервер/ключ без пересборки (тесты, превью):
  переменные окружения `AEROOPT_LICENSE_SERVER`, `AEROOPT_LICENSE_HMAC_KEY`.
