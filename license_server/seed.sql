-- ============================================================
-- Seed data: тестовые license-ключи для разработки
-- ============================================================
-- Запуск: npx wrangler d1 execute aeroopt-licenses --file=seed.sql
-- ============================================================

INSERT OR IGNORE INTO licenses (license_key, email, product, issued_at, max_hwid_count, note) VALUES
    ('AERO-TEST-0000-0000-0000-DEVEL', 'dev@aeroopt.app', 'personal',
     strftime('%s','now'), 5, 'Тестовый ключ для разработки (5 машин)'),
    ('AERO-DEMO-1234-5678-9ABC-EDCBA', 'demo@aeroopt.app', 'personal',
     strftime('%s','now'), 2, 'Демо-ключ для скринкастов (2 машины)');
