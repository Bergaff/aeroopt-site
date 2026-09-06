-- ============================================================
-- Миграция боевой базы aeroopt-licenses на схему 2026 (API-лицензии)
-- ============================================================
-- Запуск (боевая база):
--   cd license_server
--   npx wrangler d1 execute aeroopt-licenses --remote --file=migrate_2026.sql
--
-- Операции идемпотентны. SQLite/D1 не умеет ADD COLUMN IF NOT EXISTS,
-- поэтому если колонка уже существует — wrangler покажет ошибку вида
-- "duplicate column name" на ЭТОМ операторе и продолжит со следующего.
-- Это нормально, данные не затрагиваются.
--
-- Что добавляет миграция:
--   licenses.expires_at   — срок действия (unix ts; NULL = бессрочно)
--   licenses.features     — JSON-массив фич ["basic","rans","gpu",...]
--   activations.revoked_at— мягкая отвязка машины (вместо только is_active)
--
-- После миграции:
--   1) задеплоить новый воркер: npx wrangler deploy
--   2) задать секрет LICENSE_HMAC_KEY (см. DEPLOY_STEPS.md)
--   3) перенести старые ключи: ниже блока ALTER идут INSERT'ы
--      демо/боевых ключей из бывшего публичного licenses.json.
-- ============================================================

-- --- licenses: срок действия и фичи ---
ALTER TABLE licenses ADD COLUMN expires_at INTEGER;
ALTER TABLE licenses ADD COLUMN features TEXT;

-- --- activations: мягкий revoke (поддержка и старого is_active) ---
ALTER TABLE activations ADD COLUMN revoked_at TEXT;

-- ============================================================
-- Перенос ключей из бывшего публичного licenses.json (GitHub)
-- ============================================================
-- Эти ключи раньше лежали в открытом репозитории и считаются
-- скомпрометированными для продакшена. Demo/TEST-ключи оставляем
-- для разработки (они публичны и не дают коммерческой ценности).
-- Боевые купленные ключи в этой таблице НЕ публиковались —
-- их выдавать заново через /v1/admin/issue (админка на сайте).
--
-- expires_at: unix-секунды. 2027-12-31 (UTC) = 1830211200.
INSERT OR IGNORE INTO licenses
    (license_key, plan, max_machines, customer_email, note, expires_at, features, created_at, updated_at)
VALUES
    ('AERO-DEMO-2026-TEST', 'pro', 2, 'demo@aeroopt.app',
     'Демо-ключ из старого licenses.json (публичный, для проверки связи)',
     1830211200,
     '["basic","sweep","optimization","rans","gpu"]',
     datetime('now'), datetime('now'));

-- Проверка результата (выполните отдельно, чтобы убедиться):
-- npx wrangler d1 execute aeroopt-licenses --remote \
--   --command="SELECT license_key, plan, max_machines, expires_at, revoked_at FROM licenses"
