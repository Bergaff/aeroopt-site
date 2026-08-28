/**
 * AeroOpt License Server — Cloudflare Worker
 * ===========================================
 *
 * Единственный источник истины по лицензиям — D1 (база Cloudflare).
 * Публичного licenses.json больше НЕТ: ключи не лежат в открытом Git,
 * десктоп-приложение ходит сюда по HTTPS.
 *
 * Endpoints (все POST, JSON):
 *   POST /v1/activate        — активация ключа на машине (привязка HWID)
 *   POST /v1/heartbeat       — периодическая проверка (раз в ~30 дней)
 *   POST /v1/deactivate      — отвязка машины (из приложения или кабинета)
 *   POST /v1/run_token       — короткоживущий токен на запуск расчёта
 *   POST /v1/check_update    — последняя версия приложения
 *   POST /v1/account_info    — read-only данные для личного кабинета
 *   POST /v1/stripe_webhook  — Stripe: оплата → ключ автоматически в БД
 *   GET  /v1/admin/list      — список лицензий            (X-Admin-Token)
 *   GET  /v1/admin/inspect   — детали по ключу            (X-Admin-Token)
 *   POST /v1/admin/issue     — выдать ключ                (X-Admin-Token)
 *   POST /v1/admin/revoke    — отозвать ключ              (X-Admin-Token)
 *   POST /v1/admin/restore   — снять отзыв                (X-Admin-Token)
 *   POST /v1/admin/set_note  — примечание                 (X-Admin-Token)
 *   GET  /healthz            — пинг
 *
 * Подпись ответов: HMAC-SHA256 по КАНОНИЧЕСКОМУ JSON (ключи отсортированы,
 * без пробелов). Клиент (license_checker.py) считает ровно так же.
 * Секрет — env.LICENSE_HMAC_KEY (wrangler secret), и он же вшит в клиент.
 *
 * Схема БД — schema.sql (новая база) и migrate_2026.sql (боевая база).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Git-деплой иногда без nodejs_compat — глобального Buffer нет.
if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = {
        from(data, enc) {
            if (typeof data === 'string') {
                if (enc === 'hex') {
                    const hex = data.length % 2 ? '0' + data : data;
                    const u = new Uint8Array(hex.length / 2);
                    for (let i = 0; i < u.length; i++) {
                        u[i] = parseInt(hex.substr(i * 2, 2), 16);
                    }
                    return u;
                }
                return new TextEncoder().encode(data);
            }
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (ArrayBuffer.isView(data)) {
                return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            }
            return new Uint8Array(data);
        },
    };
}

// =====================================================================
// Константы
// =====================================================================

// Срок подписки по продуктам (для покупок и trial). null = бессрочно.
const PRODUCTS = {
    personal: { default_machines: 2, duration_days: null,
               features: ['basic', 'sweep', 'optimization'] },
    pro:      { default_machines: 3, duration_days: null,
               features: ['basic', 'sweep', 'optimization', 'rans', 'gpu'] },
    edu:      { default_machines: 1, duration_days: null,
               features: ['basic', 'sweep', 'optimization', 'rans'] },
    trial:    { default_machines: 1, duration_days: 14,
               features: ['basic', 'sweep'] },
};

const GRACE_DAYS = 7;          // дни после истечения, когда приложение ещё работает
const OFFLINE_DAYS = 60;       // столько дней разрешено работать без сети
const RUN_TOKEN_TTL = 300;     // 5 минут

const DAY = 86400;

// CORS: приложение (AeroOpt.exe) шлёт запросы без Origin — для него
// проверки нет. Браузерные запросы (админка/кабинет) — со списком доменов.
const ALLOWED_ORIGINS = [
    'https://aeroopt.app',
    'https://www.aeroopt.app',
    'https://bergaff.github.io',
    'https://aeroopt-site.pages.dev',
    'http://localhost:8000',
    'http://localhost:8080',
    'http://localhost:8788',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8788',
    'null', // file://
];

function corsHeadersFor(request) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-AeroOpt-Client, X-Admin-Token',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

// =====================================================================
// Ответы
// =====================================================================

const json = (data, status = 200, extraHeaders = {}) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...(globalThis.__CORS_HEADERS__ || {}),
            ...extraHeaders,
        },
    });

const err = (code, message, status = 400) =>
    json({ ok: false, code, message, server_ts: Math.floor(Date.now() / 1000) }, status);

const ok = (data) =>
    json({ ok: true, server_ts: Math.floor(Date.now() / 1000), ...data });

// =====================================================================
// Криптография
// =====================================================================

// Канонический JSON: ключи объектов отсортированы, без пробелов,
// массивы в исходном порядке. Только такие типы: null/bool/число/строка/
// массив/объект — ровно то, что кладётся в подпись.
function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function hmacHex(secret, msg) {
    return createHmac('sha256', String(secret || '')).update(msg, 'utf8').digest('hex');
}

// Поля, которые подписываются в ответе активации/heartbeat.
// ВАЖНО: тот же белый список и та же сортировка — в license_checker.py.
const SIGNED_FIELDS = [
    'status', 'license_key', 'hwid', 'product', 'plan',
    'expires_at', 'grace_until', 'offline_until',
    'hwid_count', 'hwid_max', 'features', 'token', 'server_ts',
];

function signLicensePayload(extra, secret) {
    const payload = { server_ts: Math.floor(Date.now() / 1000) };
    for (const f of SIGNED_FIELDS) {
        if (extra[f] !== undefined) payload[f] = extra[f];
    }
    const signature = hmacHex(secret, canonical(payload));
    return { payload, signature };
}

async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function genLicenseKey() {
    const blocks = 4;
    const blockLen = 4;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O/1/I
    let out = 'AERO';
    const rnd = randomBytes(blocks * blockLen);
    for (let b = 0; b < blocks; b++) {
        out += '-';
        for (let i = 0; i < blockLen; i++) out += chars[rnd[b * blockLen + i] % chars.length];
    }
    return out;
}

function toUnix(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) {
        return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    }
    const str = String(v).trim();
    if (/^\d+$/.test(str)) {
        const n = parseInt(str, 10);
        return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    const t = Date.parse(str.includes('T') ? str : str.replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function featuresForPlan(plan) {
    return (PRODUCTS[plan] || PRODUCTS.personal).features;
}

// Статус лицензии по сроку: active | grace | expired
function licenseTimeStatus(expiresAt, now) {
    if (!expiresAt) return 'active'; // бессрочная
    if (expiresAt > now) return 'active';
    if (expiresAt + GRACE_DAYS * DAY > now) return 'grace';
    return 'expired';
}

// =====================================================================
// D1 helpers (совместимы со старой и новой схемой activations)
// =====================================================================

async function getLicense(env, key) {
    // Каноническая схема: plan / max_machines. Поля product / max_hwid_count
    // оставлены в JS-нормализаторах (licensePlan/licenseMaxMachines) на случай
    // совсем старых баз, но в SQL их не запрашиваем — D1 падает на
    // несуществующих колонках.
    return env.DB.prepare(
        'SELECT license_key, plan, max_machines, customer_email, email, note, ' +
        'expires_at, revoked_at, revoked_reason, created_at, features ' +
        'FROM licenses WHERE license_key = ?'
    ).bind(key).first();
}

function licenseMaxMachines(row) {
    return row.max_machines ?? row.max_hwid_count ?? 2;
}
function licensePlan(row) {
    return row.plan || row.product || 'personal';
}
function licenseExpires(row) {
    return toUnix(row.expires_at);
}
function licenseFeatures(row) {
    if (row.features) {
        try {
            const f = JSON.parse(row.features);
            if (Array.isArray(f) && f.length) return f;
        } catch { /* битый JSON — дефолт по плану */ }
    }
    return featuresForPlan(licensePlan(row));
}

// Активные привязки (revoked_at в новой схеме, is_active=0 в старой).
async function getActiveActivations(env, key) {
    try {
        const r = await env.DB.prepare(
            'SELECT hwid, hostname, os, app_version, first_seen, last_seen ' +
            'FROM activations WHERE license_key = ? AND revoked_at IS NULL ' +
            'ORDER BY last_seen DESC'
        ).bind(key).all();
        return r.results || [];
    } catch {
        const r = await env.DB.prepare(
            'SELECT hwid, hostname, os, app_version, first_seen, last_seen ' +
            'FROM activations WHERE license_key = ? AND is_active = 1 ' +
            'ORDER BY last_seen DESC'
        ).bind(key).all();
        return r.results || [];
    }
}

async function getActivation(env, key, hwid) {
    const row = await env.DB.prepare(
        'SELECT hwid, hostname, os, app_version, first_seen, last_seen, last_token, ' +
        'is_active, revoked_at FROM activations WHERE license_key = ? AND hwid = ?'
    ).bind(key, hwid).first();
    if (!row) return null;
    return { ...row, active: !row.revoked_at && row.is_active !== 0 };
}

async function deactivateActivation(env, key, hwid) {
    const now = Math.floor(Date.now() / 1000);
    try {
        const r = await env.DB.prepare(
            "UPDATE activations SET revoked_at = datetime('now'), is_active = 0, last_seen = ? " +
            'WHERE license_key = ? AND hwid = ? AND revoked_at IS NULL'
        ).bind(now, key, hwid).run();
        return r.meta.changes > 0;
    } catch {
        const r = await env.DB.prepare(
            'UPDATE activations SET is_active = 0, last_seen = ? ' +
            'WHERE license_key = ? AND hwid = ? AND is_active = 1'
        ).bind(now, key, hwid).run();
        return r.meta.changes > 0;
    }
}

// =====================================================================
// Клиентские эндпоинты
// =====================================================================

/**
 * POST /v1/activate
 * body: { license_key, hwid, hostname, os, app_version }
 * → { status, token, product, expires_at, grace_until, hwid_count, hwid_max, features, signature }
 */
async function handleActivate(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key, hwid, hostname, os, app_version } = body;
    if (!license_key || !hwid) return err('bad_request', 'license_key and hwid required');
    if (typeof hwid !== 'string' || hwid.length < 16 || hwid.length > 256) {
        return err('bad_request', 'hwid has invalid format');
    }
    const key = String(license_key).trim().toUpperCase();
    const now = Math.floor(Date.now() / 1000);

    const license = await getLicense(env, key);
    if (!license) return err('invalid_key', 'License key not found', 404);
    if (license.revoked_at) {
        return err('revoked', 'License revoked. Contact support@aeroopt.app', 403);
    }

    const expiresAt = licenseExpires(license);
    const timeStatus = licenseTimeStatus(expiresAt, now);
    if (timeStatus === 'expired') {
        return err('expired', 'License expired. Renew at https://aeroopt.app', 403);
    }

    const plan = licensePlan(license);
    const maxMachines = licenseMaxMachines(license);
    const features = licenseFeatures(license);

    const active = await getActiveActivations(env, key);
    const hwidList = active.map((a) => a.hwid);
    const alreadyBound = hwidList.includes(hwid);
    if (!alreadyBound && hwidList.length >= maxMachines) {
        return err('hwid_limit',
            `Max ${maxMachines} machines. Deactivate old machine at https://aeroopt.app/account`,
            403);
    }

    const token = randomBytes(32).toString('hex');

    if (alreadyBound) {
        await env.DB.prepare(
            'UPDATE activations SET last_seen = ?, last_token = ?, last_token_ts = ?, ' +
            'hostname = COALESCE(?, hostname), os = COALESCE(?, os), ' +
            'app_version = COALESCE(?, app_version), is_active = 1 ' +
            'WHERE license_key = ? AND hwid = ?'
        ).bind(now, token, now, hostname || null, os || null, app_version || null,
               key, hwid).run();
        // На случай повторной активации отвязанной машины — снимаем revoke.
        try {
            await env.DB.prepare(
                'UPDATE activations SET revoked_at = NULL, is_active = 1 ' +
                'WHERE license_key = ? AND hwid = ? AND revoked_at IS NOT NULL'
            ).bind(key, hwid).run();
        } catch { /* старая схема без revoked_at */ }
    } else {
        try {
            await env.DB.prepare(
                'INSERT INTO activations ' +
                '(license_key, hwid, hostname, os, app_version, first_seen, last_seen, ' +
                'last_token, last_token_ts, is_active) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
            ).bind(key, hwid, hostname || null, os || null, app_version || null,
                   now, now, token, now).run();
        } catch (e) {
            // unique(license_key, hwid): запись уже существует (была отвязана)
            // — реактивируем её.
            await env.DB.prepare(
                'UPDATE activations SET revoked_at = NULL, is_active = 1, last_seen = ?, ' +
                'last_token = ?, last_token_ts = ?, hostname = COALESCE(?, hostname), ' +
                'os = COALESCE(?, os), app_version = COALESCE(?, app_version) ' +
                'WHERE license_key = ? AND hwid = ?'
            ).bind(now, token, now, hostname || null, os || null, app_version || null,
                   key, hwid).run().catch(() => null);
        }
    }

    await logHeartbeat(env, key, hwid, app_version);

    const { payload, signature } = signLicensePayload({
        status: timeStatus,
        license_key: key,
        hwid,
        product: plan,
        plan,
        expires_at: expiresAt,
        grace_until: expiresAt ? expiresAt + GRACE_DAYS * DAY : null,
        offline_until: now + OFFLINE_DAYS * DAY,
        hwid_count: alreadyBound ? hwidList.length : hwidList.length + 1,
        hwid_max: maxMachines,
        features,
        token,
    }, env.LICENSE_HMAC_KEY);

    return ok({ ...payload, signature });
}

/**
 * POST /v1/heartbeat
 * body: { license_key, hwid, token?, app_version? }
 * → тот же формат, что и activate (новый token + статус)
 */
async function handleHeartbeat(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key, hwid, token, app_version } = body;
    if (!license_key || !hwid) return err('bad_request', 'license_key and hwid required');
    const key = String(license_key).trim().toUpperCase();
    const now = Math.floor(Date.now() / 1000);

    const license = await getLicense(env, key);
    if (!license) return err('invalid_key', 'License key not found', 404);
    if (license.revoked_at) {
        return err('revoked', 'License revoked. Contact support@aeroopt.app', 403);
    }

    const activation = await getActivation(env, key, hwid);
    if (!activation) {
        return err('not_bound', 'This machine is not activated. Activate first.', 404);
    }
    if (!activation.active) {
        return err('deactivated', 'This machine was deactivated', 403);
    }

    // token проверяем, если клиент его прислал (защита от replay/угона)
    if (token && activation.last_token && token !== activation.last_token) {
        const tokenHash = await sha256Hex(token);
        const revoked = await env.DB.prepare(
            'SELECT 1 FROM revoked_tokens WHERE token_hash = ?'
        ).bind(tokenHash).first().catch(() => null);
        if (revoked) return err('bad_token', 'Invalid token', 403);
    }

    const expiresAt = licenseExpires(license);
    const timeStatus = licenseTimeStatus(expiresAt, now);
    if (timeStatus === 'expired') {
        return err('expired', 'License expired. Renew at https://aeroopt.app', 403);
    }

    const newToken = randomBytes(32).toString('hex');
    await env.DB.prepare(
        'UPDATE activations SET last_seen = ?, last_token = ?, last_token_ts = ?, ' +
        'app_version = COALESCE(?, app_version) WHERE license_key = ? AND hwid = ?'
    ).bind(now, newToken, now, app_version || null, key, hwid).run();

    await logHeartbeat(env, key, hwid, app_version);

    const active = await getActiveActivations(env, key);
    const { payload, signature } = signLicensePayload({
        status: timeStatus,
        license_key: key,
        hwid,
        product: licensePlan(license),
        plan: licensePlan(license),
        expires_at: expiresAt,
        grace_until: expiresAt ? expiresAt + GRACE_DAYS * DAY : null,
        offline_until: now + OFFLINE_DAYS * DAY,
        hwid_count: active.length,
        hwid_max: licenseMaxMachines(license),
        features: licenseFeatures(license),
        token: newToken,
    }, env.LICENSE_HMAC_KEY);

    return ok({ ...payload, signature });
}

async function logHeartbeat(env, key, hwid, appVersion) {
    await env.DB.prepare(
        'INSERT INTO heartbeats (license_key, hwid, ts, runs_count, app_version) ' +
        'VALUES (?, ?, ?, 0, ?)'
    ).bind(key, hwid, Math.floor(Date.now() / 1000), appVersion || null)
     .run().catch(() => { /* таблица может отсутствовать — не критично */ });
}

/**
 * POST /v1/deactivate
 * body: { license_key, hwid, token? }
 * Отвязка машины: вызывается и из приложения (меню «Отвязать»),
 * и из личного кабинета на сайте (там токена нет — это ок,
 * связка license_key+hwid и есть секрет владельца).
 */
async function handleDeactivate(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key, hwid, token } = body;
    if (!license_key || !hwid) return err('bad_request', 'license_key and hwid required');
    const key = String(license_key).trim().toUpperCase();

    const done = await deactivateActivation(env, key, hwid);
    if (!done) return err('not_found', 'No active binding for this machine', 404);

    if (token) {
        const tokenHash = await sha256Hex(token);
        await env.DB.prepare(
            'INSERT OR IGNORE INTO revoked_tokens (token_hash, license_key, revoked_at) ' +
            'VALUES (?, ?, ?)'
        ).bind(tokenHash, key, Math.floor(Date.now() / 1000)).run().catch(() => {});
    }
    return ok({ deactivated: true });
}

/**
 * POST /v1/run_token
 * body: { license_key, hwid, token }
 * Короткоживущий токен на запуск расчёта (TTL 5 минут).
 */
async function handleRunToken(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key, hwid, token } = body;
    if (!license_key || !hwid || !token) {
        return err('bad_request', 'license_key, hwid, token required');
    }
    const key = String(license_key).trim().toUpperCase();
    const now = Math.floor(Date.now() / 1000);

    const license = await getLicense(env, key);
    if (!license) return err('invalid_key', 'License key not found', 404);
    if (license.revoked_at) return err('revoked', 'License revoked', 403);
    const expiresAt = licenseExpires(license);
    if (licenseTimeStatus(expiresAt, now) === 'expired') {
        return err('expired', 'License expired', 403);
    }

    const activation = await getActivation(env, key, hwid);
    if (!activation || !activation.active) {
        return err('not_active', 'Activation not found or deactivated', 403);
    }
    let tokenOk = false;
    try {
        tokenOk = activation.last_token &&
            timingSafeEqual(Buffer.from(activation.last_token, 'hex'),
                            Buffer.from(token, 'hex'));
    } catch { tokenOk = false; }
    if (!tokenOk) return err('bad_token', 'Invalid token', 403);

    const runToken = randomBytes(24).toString('hex');
    const payload = {
        run_token: runToken,
        ttl_seconds: RUN_TOKEN_TTL,
        license_key: key,
        hwid,
        server_ts: now,
    };
    const signature = hmacHex(env.LICENSE_HMAC_KEY, canonical(payload));
    return ok({ ...payload, signature });
}

/**
 * POST /v1/check_update
 */
async function handleCheckUpdate(req) {
    const body = await req.json().catch(() => {});
    const current = body?.current_version || '0.0.0';
    return ok({
        current_version: current,
        latest_version: '4.1.0',
        force_update: false,
        changelog: [
            '4.1.0: активация лицензии через сервер Cloudflare (ключи больше не публикуются)',
            '4.1.0: гибридный CPU+GPU режим',
            '4.1.0: плоскость симметрии (ускорение ~1.8x)',
            '4.1.0: RANS SST (Menter k-omega)',
            '4.1.0: mesh partition для многоядерных расчётов',
        ],
    });
}

/**
 * POST /v1/account_info — личный кабинет (достаточно знать license_key)
 */
async function handleAccountInfo(req, env) {
    const body = await req.json().catch(() => null);
    if (!body?.license_key) return err('bad_request', 'license_key required');
    const key = String(body.license_key).trim().toUpperCase();

    const license = await getLicense(env, key);
    if (!license) return err('not_found', 'License not found', 404);

    const activations = await getActiveActivations(env, key);
    const heartbeats = await env.DB.prepare(
        'SELECT ts, app_version FROM heartbeats WHERE license_key = ? ' +
        'ORDER BY ts DESC LIMIT 50'
    ).bind(key).all().catch(() => ({ results: [] }));

    return ok({
        license: {
            key: license.license_key,
            email: license.customer_email || license.email || '',
            product: licensePlan(license),
            expires_at: licenseExpires(license),
            hwid_max: licenseMaxMachines(license),
            revoked: !!license.revoked_at,
            note: license.note || '',
            features: licenseFeatures(license),
        },
        activations: activations.map((a) => ({
            hwid: a.hwid,
            hostname: a.hostname || '',
            os: a.os || '',
            app_version: a.app_version || '',
            first_seen: toUnix(a.first_seen) ?? a.first_seen,
            last_seen: toUnix(a.last_seen) ?? a.last_seen,
            is_active: true,
        })),
        heartbeats: (heartbeats.results || []).map((h) => ({
            ts: toUnix(h.ts) ?? h.ts,
            app_version: h.app_version,
            runs_count: 0,
        })),
    });
}

// =====================================================================
// Stripe: оплата → автоматическая выдача ключа в D1
// =====================================================================

/**
 * POST /v1/stripe_webhook
 *
 * Настройка в Stripe Dashboard:
 *   Developers → Webhooks → Add endpoint:
 *     URL:           https://<воркер>.workers.dev/v1/stripe_webhook
 *     Events:        checkout.session.completed
 *   В Price/Product каждого тарифа в metadata:
 *     product=personal  |  product=pro
 *   (или metadata на Checkout Session: product=personal)
 * Секрет подписи (whsec_...) → wrangler secret put STRIPE_WEBHOOK_SECRET
 */
async function handleStripeWebhook(req, env) {
    const sigHeader = req.headers.get('stripe-signature');
    if (!sigHeader) return err('bad_sig', 'Missing stripe-signature', 400);
    const bodyText = await req.text();

    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        return err('misconfigured', 'STRIPE_WEBHOOK_SECRET not set', 500);
    }

    let eventTs = null;
    let eventSig = null;
    for (const part of sigHeader.split(',')) {
        const [k, v] = part.split('=');
        if (k === 't') eventTs = v;
        if (k === 'v1') eventSig = v;
    }
    if (!eventTs || !eventSig) return err('bad_sig', 'Invalid stripe-signature', 400);

    const expected = createHmac('sha256', webhookSecret)
        .update(`${eventTs}.${bodyText}`, 'utf8').digest('hex');
    let sigOk = false;
    try {
        sigOk = expected.length === eventSig.length &&
            timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(eventSig, 'hex'));
    } catch { sigOk = false; }
    if (!sigOk) return err('bad_sig', 'Stripe signature verification failed', 400);

    const age = Math.floor(Date.now() / 1000) - parseInt(eventTs, 10);
    if (age > 300 || age < -300) return err('stale', 'Webhook timestamp too old', 400);

    let event;
    try { event = JSON.parse(bodyText); } catch {
        return err('bad_json', 'Cannot parse Stripe payload', 400);
    }

    // Идемпотентность
    const seen = await env.DB.prepare(
        'SELECT 1 FROM stripe_events WHERE event_id = ?'
    ).bind(event.id).first().catch(() => null);
    if (seen) return ok({ duplicate: true });

    let licenseKey = null;
    if (event.type === 'checkout.session.completed' && event.data?.object) {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        // product: metadata сессии → metadata line_items/price → дефолт personal
        const product = (session.metadata?.product
            || session.metadata?.plan
            || 'personal').toLowerCase();
        const spec = PRODUCTS[product] || PRODUCTS.personal;
        if (email) {
            licenseKey = genLicenseKey();
            const now = Math.floor(Date.now() / 1000);
            const expiresAt = spec.duration_days ? now + spec.duration_days * DAY : null;
            const features = JSON.stringify(spec.features);
            await env.DB.prepare(
                'INSERT INTO licenses ' +
                '(license_key, plan, max_machines, customer_email, email, ' +
                ' expires_at, features, note, created_at, updated_at) ' +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
            ).bind(licenseKey, product, spec.default_machines, email, email,
                   expiresAt, features, 'stripe:' + (session.id || '')).run();
            console.log(`[license] issued ${licenseKey} for ${email} (${product})`);

            // Письмо с ключом (если настроен Resend)
            if (env.RESEND_API_KEY && env.RESEND_FROM) {
                await sendLicenseEmail(env, email, licenseKey, product,
                                       spec.default_machines).catch((e) =>
                    console.error('[license] email failed:', e));
            }
        }
    }

    await env.DB.prepare(
        'INSERT INTO stripe_events (event_id, event_type, payload, processed_at, license_key) ' +
        'VALUES (?, ?, ?, ?, ?)'
    ).bind(event.id, event.type, bodyText, Math.floor(Date.now() / 1000), licenseKey)
     .run().catch(() => {});

    return ok({ processed: true, license_key: licenseKey });
}

async function sendLicenseEmail(env, to, key, product, machines) {
    const productName = { personal: 'Personal', pro: 'Pro', edu: 'Educational', trial: 'Trial' }[product] || product;
    return fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: env.RESEND_FROM,
            to,
            subject: 'Ваш лицензионный ключ AeroOpt',
            text:
`Здравствуйте!

Спасибо за покупку AeroOpt (${productName}).

Ваш лицензионный ключ:

    ${key}

Как активировать:
1. Установите AeroOpt: https://aeroopt.app/#download
2. Запустите программу
3. Меню «Лицензия» → «Активировать ключ»
4. Введите ключ выше

Ключ привязывается к компьютеру (Hardware ID).
Доступно машин: ${machines}.
Перенести на другой компьютер: меню «Лицензия» → «Отвязать эту машину»,
или личный кабинет: https://aeroopt.app/account

Вопросы: support@aeroopt.app

С уважением,
Команда AeroOpt
`,
        }),
    });
}

// =====================================================================
// Admin
// =====================================================================

async function adminCheck(req, env) {
    const token = (req.headers.get('X-Admin-Token') || '').trim();
    if (!token) return { ok: false, error: err('no_admin_token', 'Missing X-Admin-Token', 401) };
    const expected = String(env.ADMIN_TOKEN || '').trim();
    if (!expected) return { ok: false, error: err('misconfigured', 'ADMIN_TOKEN not set', 500) };
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return { ok: false, error: err('bad_admin_token', 'Invalid admin token', 401) };
    let valid = false;
    try { valid = timingSafeEqual(a, b); } catch { valid = false; }
    if (!valid) return { ok: false, error: err('bad_admin_token', 'Invalid admin token', 401) };
    return { ok: true };
}

async function adminLog(env, action, licenseKey, ip, payload) {
    await env.DB.prepare(
        'INSERT INTO admin_audit_log (action, license_key, admin_ip, payload, ts) ' +
        'VALUES (?, ?, ?, ?, ?)'
    ).bind(action, licenseKey || null, ip || null,
           JSON.stringify(payload || {}), Math.floor(Date.now() / 1000))
     .run().catch((e) => console.error('adminLog failed:', e));
}

/**
 * POST /v1/admin/issue
 * body: { email, product, max_machines?, expires_in_days?, note? }
 * Это и есть «самостоятельная генерация ключей» на сайте —
 * ключ сразу попадает в D1, нигде в Git не светится.
 */
async function handleAdminIssue(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { email, product, max_machines, expires_in_days, note } = body;
    if (!email || !product) return err('bad_request', 'email and product required');
    const plan = String(product).toLowerCase();
    const spec = PRODUCTS[plan];
    if (!spec) return err('bad_product', `Unknown product: ${product}`);

    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const licenseKey = genLicenseKey();
    const machines = max_machines || spec.default_machines;
    const days = expires_in_days != null ? Number(expires_in_days) : spec.duration_days;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = days && Number.isFinite(days) ? now + days * DAY : null;
    const features = JSON.stringify(spec.features);

    try {
        await env.DB.prepare(
            'INSERT INTO licenses ' +
            '(license_key, plan, max_machines, customer_email, email, note, ' +
            ' expires_at, features, created_at, updated_at) ' +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
        ).bind(licenseKey, plan, machines, email, email, note || null,
               expiresAt, features).run();
    } catch (e) {
        return err('db_error', `DB error: ${e.message}`, 500);
    }

    await adminLog(env, 'issue', licenseKey, ip,
        { email, product: plan, max_machines: machines, expires_at: expiresAt, note });

    let emailStatus = 'not_configured';
    if (env.RESEND_API_KEY && env.RESEND_FROM) {
        try {
            const r = await sendLicenseEmail(env, email, licenseKey, plan, machines);
            emailStatus = r.ok ? 'sent' : `failed: HTTP ${r.status}`;
        } catch (e) {
            emailStatus = `error: ${e.message}`;
        }
        await adminLog(env, 'send_email', licenseKey, ip, { to: email, status: emailStatus });
    }

    return ok({
        license_key: licenseKey,
        email,
        product: plan,
        max_machines: machines,
        max_hwid_count: machines,
        expires_at: expiresAt,
        features: spec.features,
        note: note || null,
        email_status: emailStatus,
    });
}

async function handleAdminRevoke(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body?.license_key) return err('bad_request', 'license_key required');
    const key = String(body.license_key).trim().toUpperCase();
    const reason = body.reason || null;
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';

    const result = await env.DB.prepare(
        "UPDATE licenses SET revoked_at = datetime('now'), revoked_reason = ?, " +
        "updated_at = datetime('now') WHERE license_key = ? AND revoked_at IS NULL"
    ).bind(reason, key).run();
    if (result.meta.changes === 0) return err('not_found', 'License not found or already revoked', 404);

    // Отвязываем все машины
    try {
        await env.DB.prepare(
            "UPDATE activations SET revoked_at = datetime('now') WHERE license_key = ?"
        ).bind(key).run();
    } catch {
        await env.DB.prepare(
            'UPDATE activations SET is_active = 0 WHERE license_key = ?'
        ).bind(key).run().catch(() => {});
    }
    await adminLog(env, 'revoke', key, ip, { reason });
    return ok({ revoked_at: new Date().toISOString(), reason });
}

async function handleAdminRestore(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body?.license_key) return err('bad_request', 'license_key required');
    const key = String(body.license_key).trim().toUpperCase();
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const result = await env.DB.prepare(
        "UPDATE licenses SET revoked_at = NULL, revoked_reason = NULL, " +
        "updated_at = datetime('now') WHERE license_key = ? AND revoked_at IS NOT NULL"
    ).bind(key).run();
    if (result.meta.changes === 0) return err('not_revoked', 'License is not revoked', 400);
    await adminLog(env, 'restore', key, ip, {});
    return ok({ license_key: key });
}

async function handleAdminSetNote(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body?.license_key) return err('bad_request', 'license_key required');
    const key = String(body.license_key).trim().toUpperCase();
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const result = await env.DB.prepare(
        "UPDATE licenses SET note = ?, updated_at = datetime('now') WHERE license_key = ?"
    ).bind(body.note || null, key).run();
    if (result.meta.changes === 0) return err('not_found', 'License key not found', 404);
    await adminLog(env, 'set_note', key, ip, { note: body.note || null });
    return ok({ license_key: key, note: body.note || null });
}

async function handleAdminList(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const url = new URL(req.url);
    const product = url.searchParams.get('product');
    const activeOnly = url.searchParams.get('active_only') === '1';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

    let sql =
        'SELECT license_key, plan, max_machines, customer_email, ' +
        'email, note, revoked_at, revoked_reason, expires_at, features, created_at ' +
        'FROM licenses WHERE 1=1';
    const args = [];
    if (product) { sql += ' AND plan = ?'; args.push(product); }
    if (activeOnly) sql += ' AND revoked_at IS NULL';
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);

    try {
        const rows = await env.DB.prepare(sql).bind(...args).all();
        const list = [];
        for (const r of rows.results || []) {
            const active = await getActiveActivations(env, r.license_key);
            list.push({
                license_key: r.license_key,
                email: r.customer_email || r.email || '',
                product: licensePlan(r),
                issued_at: toUnix(r.created_at),
                expires_at: toUnix(r.expires_at),
                max_machines: licenseMaxMachines(r),
                note: r.note,
                revoked_at: r.revoked_at,
                revoked_reason: r.revoked_reason,
                active_machines: active.length,
                features: licenseFeatures(r),
                is_active: !r.revoked_at,
            });
        }
        return ok({ licenses: list, total: list.length, limit, offset });
    } catch (e) {
        return err('db_error', String(e?.message || e), 500);
    }
}

async function handleAdminInspect(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const url = new URL(req.url);
    const key = url.searchParams.get('license_key');
    if (!key) return err('bad_request', 'license_key query param required');
    const norm = String(key).trim().toUpperCase();

    const row = await getLicense(env, norm);
    if (!row) return err('not_found', 'License not found', 404);

    const activations = await env.DB.prepare(
        'SELECT hwid, hostname, os, app_version, first_seen, last_seen, revoked_at, is_active ' +
        'FROM activations WHERE license_key = ? ORDER BY last_seen DESC'
    ).bind(norm).all().catch(() => ({ results: [] }));
    const heartbeats = await env.DB.prepare(
        'SELECT ts, app_version FROM heartbeats WHERE license_key = ? ORDER BY ts DESC LIMIT 100'
    ).bind(norm).all().catch(() => ({ results: [] }));
    const audit = await env.DB.prepare(
        'SELECT action, admin_ip, payload, ts FROM admin_audit_log ' +
        'WHERE license_key = ? ORDER BY ts DESC LIMIT 50'
    ).bind(norm).all().catch(() => ({ results: [] }));

    return ok({
        license: {
            key: row.license_key,
            product: licensePlan(row),
            email: row.customer_email || row.email || '',
            max_machines: licenseMaxMachines(row),
            expires_at: licenseExpires(row),
            features: licenseFeatures(row),
            note: row.note || '',
            revoked_at: row.revoked_at,
            revoked_reason: row.revoked_reason,
            created_at: toUnix(row.created_at),
        },
        activations: (activations.results || []).map((a) => ({
            ...a,
            first_seen: toUnix(a.first_seen) ?? a.first_seen,
            last_seen: toUnix(a.last_seen) ?? a.last_seen,
            is_active: !a.revoked_at && a.is_active !== 0,
        })),
        heartbeats: heartbeats.results,
        audit: audit.results,
    });
}

// =====================================================================
// Роутер
// =====================================================================

export default {
    async fetch(req, env, ctx) {
        globalThis.__CORS_HEADERS__ = corsHeadersFor(req);

        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeadersFor(req) });
        }

        const url = new URL(req.url);
        const path = url.pathname;

        try {
            if (path === '/healthz') return ok({ status: 'ok', version: '4.1.0' });

            if (req.method === 'POST') {
                switch (path) {
                    case '/v1/activate':       return await handleActivate(req, env);
                    case '/v1/heartbeat':      return await handleHeartbeat(req, env);
                    case '/v1/deactivate':     return await handleDeactivate(req, env);
                    case '/v1/run_token':      return await handleRunToken(req, env);
                    case '/v1/check_update':   return await handleCheckUpdate(req, env);
                    case '/v1/account_info':   return await handleAccountInfo(req, env);
                    case '/v1/stripe_webhook': return await handleStripeWebhook(req, env);
                    case '/v1/admin/issue':    return await handleAdminIssue(req, env);
                    case '/v1/admin/revoke':   return await handleAdminRevoke(req, env);
                    case '/v1/admin/restore':  return await handleAdminRestore(req, env);
                    case '/v1/admin/set_note': return await handleAdminSetNote(req, env);
                }
            }
            if (req.method === 'GET') {
                switch (path) {
                    case '/v1/admin/list':    return await handleAdminList(req, env);
                    case '/v1/admin/inspect': return await handleAdminInspect(req, env);
                }
            }

            return err('not_found', `No route for ${req.method} ${path}`, 404);
        } catch (e) {
            console.error('[worker] unhandled error:', e);
            return err('server_error', String(e?.message || e), 500);
        }
    },
};
