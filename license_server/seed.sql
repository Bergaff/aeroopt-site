-- ============================================================
-- Seed data: тестовые лицензии (только для разработки!)
-- ============================================================
--   npx wrangler d1 execute aeroopt-licenses --file=seed.sql
--
-- expires_at: unix ts. Здесь demo/developer ключи сделаны бессрочными
-- (expires_at = NULL); trial-ключ живёт 14 дней от момента вставки.
-- Фичи:
--   personal → ["basic","sweep","optimization"]
--   pro      → ["basic","sweep","optimization","rans","gpu"]
--   edu      → ["basic","sweep","optimization","rans"]
--   trial    → ["basic","sweep"]
-- ============================================================

INSERT OR IGNORE INTO licenses
    (license_key, plan, max_machines, customer_email, email, note,
     expires_at, features, created_at, updated_at)
VALUES
    ('AERO-TEST-0000-0000-0001-DEVL', 'pro', 5, 'dev@aeroopt.app', 'dev@aeroopt.app',
     'Тестовый ключ для разработки (5 машин)',
     NULL, '["basic","sweep","optimization","rans","gpu"]',
     datetime('now'), datetime('now')),
    ('AERO-DEMO-1234-5678-9ABC-EDCB', 'personal', 2, 'demo@aeroopt.app', 'demo@aeroopt.app',
     'Демо-ключ для скринкастов (2 машины)',
     NULL, '["basic","sweep","optimization"]',
     datetime('now'), datetime('now')),
    ('AERO-TRI-AL00-0000-0000-0001', 'trial', 1, 'trial@aeroopt.app', 'trial@aeroopt.app',
     'Trial 14 дней от момента сидирования',
     CAST(strftime('%s','now') AS INTEGER) + 14*86400,
     '["basic","sweep"]',
     datetime('now'), datetime('now'));
