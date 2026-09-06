# Интеграция лицензий в десктопное приложение AeroOpt

Архитектура 4.1: **AeroOpt → Cloudflare Worker (HTTPS) → D1**.

## Что куда положить

В папке с десктопным проектом (рядом с `main.py`, `ui/`):

```
license_client/__init__.py
license_client/license_checker.py   # новый клиент — заменяет старый целиком
diagnose_license.py                 # диагностика (главное окно + отчёт)
```

Старый `license_client/license_checker.py` (с публичным licenses.json,
rsa-хелперами, local_decrypt и т.п.) **удалить** — все его публичные методы
сохранены в новом с теми же именами:

| Старый метод | Новый — сигнатура та же |
|---|---|
| `bootstrap()` | `bootstrap() -> LicenseStatus` |
| `activate(key)` | `activate(key) -> (bool, str)` |
| `heartbeat()` | `heartbeat() -> (bool, str)` |
| `deactivate()` | `deactivate() -> (bool, str)` |
| `is_calculation_allowed()` | `is_calculation_allowed() -> (bool, str)` |
| `acquire_run_token()` | `acquire_run_token() -> (bool, str)` |
| `get_status_text()` | `get_status_text() -> str` |
| `get_short_status_text()` | `get_short_status_text() -> str` |
| `get_activation_info()` | `get_activation_info() -> dict` |

Класс `LicenseStatus` с теми же значениями: `active, grace, expired,
network_error, hwid_limit, revoked, trial, no_key`. Поэтому `ui/main_window.py`,
`ui/dialogs.py`, `main.py` **в коде менять не нужно** — только заменить
папку `license_client`.

Проверьте две точки интеграции (они уже были в коде):

1. Старт расчёта (`MainWindow.start_calculation` /
   `run_geometric_optimization`):
   ```python
   allowed, reason = self.license_checker.is_calculation_allowed()
   if not allowed:
       QMessageBox.warning(..., "Лицензия", reason); return
   ```
2. Длинный расчёт — периодически (раз в ~10–30 мин) вызывать
   `heartbeat()`/`is_calculation_allowed()`; гейт `run_token` проверяется
   на сервере при каждом `/v1/run_token`.

## Как это работает

- **Активация** (`/v1/activate`): ключ + HWID (SHA256 от
  MachineGuid/IOPlatformUUID/machine-id + MAC) → сервер привязывает
  машину в D1, возвращает подписанный HMAC-ответ (статус, план, фичи,
  срок, лимит машин, run-токен, окна грейса).
- **Запуск приложения** (`bootstrap()`): если кэш свежий (< 30 дней) —
  работает офлайн без сети; иначе `/v1/heartbeat`.
- **Нет сети**: до 60 дней офлайн-грейса по локальному кэшу
  (`~/.aeroopt/license.dat`, XOR-обфускация + привязка к HWID,
  скрытый файл на Windows). Активация нового ключа без сети невозможна
  (HWID пишется в базу) — это by design.
- **Окончание лицензии**: 7 дней грейса (приложение работает, видно
  предупреждение), потом расчёт блокируется.
- **Run-токен**: перед расчётом клиент запрашивает `/v1/run_token`;
  сервер проверяет актуальный статус и ротирует токен при heartbeat.
- **Отзыв ключа** админом: до 60 дней (офлайн-окно) приложение узнает
  при следующем выходе в сеть — защита держится на подписи ответов
  (подделать «лицензия активна» без HMAC-секрета нельзя).

## HMAC-ключ (обязательно совпадает с воркером)

В `license_checker.py` вшит XOR-обфусцированный секрет:

```python
_OBF_HMAC_KEY = "6d3e6d3b6b623b6c6c69683f693f3c6c3c6a3b6369693f62..."
```

На сервере задан тот же ключ (64 hex):

```
7d7a18a6632e3ef6f0a933e83bb4b5c48092b39718ea106554e4b870d04f2eaf
```

Ротация (например, при утечке):
1. `npx wrangler secret put LICENSE_HMAC_KEY` — новый секрет;
2. сгенерировать обфускацию нового ключа:
   ```python
   key = "НОВЫЙ_64_HEX".encode()
   print("".join("%02x" % (b ^ 0x5A) for b in key))
   ```
   и заменить строку `_OBF_HMAC_KEY` в `license_checker.py`;
3. пересобрать приложение.

## Сборка PyInstaller

```bat
pyinstaller --onefile --windowed --name AeroOpt ^
  --add-data "license_client;license_client" ^
  main.py
```

Подпись кода сертификатом (иначе SmartScreen):

```bat
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
  /f certificate.pfx /p ВАШ_ПАРОЛЬ dist\AeroOpt.exe
```

## Проверка после установки нового клиента

1. Запустить без ключа → «не активирована», расчёт заблокирован.
2. Меню «Лицензия» → активировать `AERO-DEMO-2026-TEST` →
   «Активирована», pro, доступны RANS/GPU.
3. Закрыть/открыть приложение без сети → работает (офлайн-кэш).
4. `python diagnose_license.py` → все пункты OK, подпись «ВЕРНА».

## Демо-ключи (в тестовой базе seed.sql)

| Ключ | План | Машин |
|---|---|---|
| `AERO-TEST-1234-5678-90AB-DEVL` | pro, бессрочно | 5 |
| `AERO-DEMO-1234-5678-90AB-CDEF` | personal | 2 |
| `AERO-TRI-AL00-0000-0000-0001` | trial | 1, 14 дней |

Боевой демо-ключ (в migrate_2026.sql, прод): `AERO-DEMO-2026-TEST`
(pro, до 2027-12-31).
