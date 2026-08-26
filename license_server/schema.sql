-- ============================================================
-- AeroOpt License Server — D1 schema
-- ============================================================
-- Полная установка (с нуля):
--   npx wrangler d1 create aeroopt-licenses
--   npx wrangler d1 execute aeroopt-licenses --file=schema.sql
--   npx wrangler d1 execute aeroopt-licenses --file=seed.sql
--
-- Миграция (если БД уже создана по старой схеме):
--   npx wrangler d1 execute aeroopt-licenses --file=schema.sql
--   (операции CREATE TABLE IF NOT EXISTS и ALTER безопасно повторяются)
-- ============================================================

-- License keys
-- Прод-D1 (aeroopt-licenses) уже создана с колонками:
--   license_key, plan, max_machines, customer_email, note,
--   revoked_at, revoked_reason, created_at, updated_at, email
-- CREATE ниже — только для новой пустой базы. IF NOT EXISTS не меняет живую таблицу.
CREATE TABLE IF NOT EXISTS licenses (
    license_key     TEXT    PRIMARY KEY,             -- "AERO-XXXX-XXXX-XXXX-XXXX"
    plan            TEXT    NOT NULL,                -- personal|pro|edu|trial
    max_machines    INTEGER NOT NULL DEFAULT 2,
    customer_email  TEXT,
    note            TEXT,
    revoked_at      TEXT,
    revoked_reason  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    email           TEXT
);

-- Привязка к HWID (история активаций)
CREATE TABLE IF NOT EXISTS activations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key     TEXT    NOT NULL,
    hwid            TEXT    NOT NULL,
    hostname        TEXT,
    os              TEXT,
    app_version     TEXT,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    last_token      TEXT,                            -- последний выданный токен
    last_token_ts   INTEGER,                         -- когда выдан
    is_active       INTEGER NOT NULL DEFAULT 1,      -- 0 = deactivated
    FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activations_key ON activations(license_key);
CREATE INDEX IF NOT EXISTS idx_activations_hwid ON activations(hwid);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activations_key_hwid
    ON activations(license_key, hwid);

-- Heartbeat / usage log (для мониторинга аномалий)
CREATE TABLE IF NOT EXISTS heartbeats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key     TEXT    NOT NULL,
    hwid            TEXT    NOT NULL,
    ts              INTEGER NOT NULL,
    runs_count      INTEGER NOT NULL DEFAULT 0,       -- сколько расчётов сделано
    app_version     TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_key_ts ON heartbeats(license_key, ts);

-- Stripe events (для аудита и отладки)
CREATE TABLE IF NOT EXISTS stripe_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT    NOT NULL UNIQUE,
    event_type      TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    processed_at    INTEGER NOT NULL,
    license_key     TEXT
);

-- Issued tokens (revocation list / отзыв токенов)
CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash      TEXT PRIMARY KEY,
    license_key     TEXT NOT NULL,
    revoked_at      INTEGER NOT NULL
);

-- ============================================================
-- АДМИНКА: audit log всех admin-действий
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action          TEXT    NOT NULL,    -- issue | revoke | set_note | send_email
    license_key     TEXT,
    admin_ip        TEXT,
    payload         TEXT,                -- JSON: что именно сделано
    ts              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_key ON admin_audit_log(license_key);
