-- ============================================================
-- Seed data: тестовые license-ключи для разработки
-- ============================================================
-- Живая D1: license_key, plan, max_machines, customer_email, note
-- Запуск: npx wrangler d1 execute aeroopt-licenses --remote --file=seed.sql
-- ============================================================

INSERT OR IGNORE INTO licenses (license_key, plan, max_machines, customer_email, note) VALUES
    ('AERO-TEST-0000-0000-0000-DEVEL', 'personal', 5, 'dev@aeroopt.app',
     'Тестовый ключ для разработки (5 машин)'),
    ('AERO-DEMO-1234-5678-9ABC-EDCBA', 'personal', 2, 'demo@aeroopt.app',
     'Демо-ключ для скринкастов (2 машины)');
