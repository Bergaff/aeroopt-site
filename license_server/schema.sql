-- ============================================================
-- AeroOpt License Server — D1 schema (полная схема для НОВОЙ базы)
-- ============================================================
--   npx wrangler d1 create aeroopt-licenses
--   npx wrangler d1 execute aeroopt-licenses --file=schema.sql
--
-- Для уже существующей боевой базы используйте migrate_2026.sql
-- (добавляет недостающие колонки ALTER'ами, данные не трогает).
-- ============================================================

-- Лицензионные ключи. Источник истины — только эта таблица (D1).
-- Никакого публичного licenses.json в Git больше нет.
CREATE TABLE IF NOT EXISTS licenses (
    license_key     TEXT    PRIMARY KEY,             -- AERO-XXXX-XXXX-XXXX-XXXX
    plan            TEXT    NOT NULL DEFAULT 'personal', -- personal|pro|edu|trial
    max_machines    INTEGER NOT NULL DEFAULT 2,
    customer_email  TEXT,
    email           TEXT,
    note            TEXT,
    expires_at      INTEGER,                          -- unix ts; NULL = бессрочно
    features        TEXT,                             -- JSON-массив фич
    revoked_at      TEXT,
    revoked_reason  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Привязки к машинам (активации). Одна строка = один ключ + один HWID.
CREATE TABLE IF NOT EXISTS activations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key     TEXT    NOT NULL,
    hwid            TEXT    NOT NULL,
    hostname        TEXT,
    os              TEXT,
    app_version     TEXT,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    last_token      TEXT,
    last_token_ts   INTEGER,
    is_active       INTEGER NOT NULL DEFAULT 1,      -- 0 = отвязана (старая схема)
    revoked_at      TEXT,                             -- NULL = активна (новая схема)
    FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activations_key ON activations(license_key);
CREATE INDEX IF NOT EXISTS idx_activations_hwid ON activations(hwid);
CREATE UNIQUE INDEX IF NOT EXISTS uq_activations_key_hwid
    ON activations(license_key, hwid);

-- Журнал heartbeat'ов (мониторинг аномалий)
CREATE TABLE IF NOT EXISTS heartbeats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    license_key     TEXT    NOT NULL,
    hwid            TEXT    NOT NULL,
    ts              INTEGER NOT NULL,
    runs_count      INTEGER NOT NULL DEFAULT 0,
    app_version     TEXT
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_key_ts ON heartbeats(license_key, ts);

-- Stripe-события (идемпотентность вебхука + аудит)
CREATE TABLE IF NOT EXISTS stripe_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT    NOT NULL UNIQUE,
    event_type      TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    processed_at    INTEGER NOT NULL,
    license_key     TEXT
);

-- Отозванные токены
CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash      TEXT PRIMARY KEY,
    license_key     TEXT NOT NULL,
    revoked_at      INTEGER NOT NULL
);

-- Аудит действий админки
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action          TEXT    NOT NULL,   -- issue | revoke | restore | set_note | send_email
    license_key     TEXT,
    admin_ip        TEXT,
    payload         TEXT,
    ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_key ON admin_audit_log(license_key);
