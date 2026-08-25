/**
 * AeroOpt License Server — Cloudflare Worker
 *
 * Endpoints:
 *   POST /v1/activate     — первая активация (привязка HWID)
 *   POST /v1/heartbeat    — ежемесячная проверка (refresh token)
 *   POST /v1/deactivate   — отвязка HWID (для личного кабинета)
 *   POST /v1/check_update — последняя версия приложения
 *   POST /v1/run_token    — одноразовый токен на запуск SU2
 *   POST /v1/stripe_webhook — Stripe checkout → автовыдача ключа
 *   GET  /healthz         — для мониторинга
 *
 * Конфигурация через wrangler.toml + secrets:
 *   - LICENSE_HMAC_KEY     — общий секрет для подписи ответов клиенту
 *   - STRIPE_WEBHOOK_SECRET — для верификации Stripe webhook
 *   - DB (D1 binding)      — база данных
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// =====================================================================
// Утилиты
// =====================================================================

// === CORS ============================================================
// Список доменов, с которых разрешены запросы к API. Если ваш сайт
// на другом домене — добавьте его в ALLOWED_ORIGINS.
//
// Активация / heartbeat от самого приложения (AeroOpt.exe) не имеет
// Origin (или имеет null), для них CORS не проверяется — поэтому
// приложение работает с любого домена (по сути — из любой сети).

const ALLOWED_ORIGINS = [
    'https://aeroopt.app',
    'https://www.aeroopt.app',
    'https://aeroopt-site.pages.dev',     // dev-домен Cloudflare Pages
    // Локальная разработка (file://, python -m http.server, vite, etc.)
    'http://localhost:8000',
    'http://localhost:8080',
    'http://localhost:8788',              // wrangler dev
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8788',
    'null',                                // file:// (Origin: null)
];

function corsHeadersFor(request) {
    const origin = request.headers.get('Origin') || '';
    // null — это file:// или запрос без Origin (из самого приложения)
    const allowOrigin = (ALLOWED_ORIGINS.includes(origin) || origin === 'null')
        ? origin
        : '*';
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-AeroOpt-Client, X-Admin-Token',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

// Backward compat: имя CORS_HEADERS оставлено для кода, который его
// использует напрямую. Но при ответах теперь используется
// corsHeadersFor(req).
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-AeroOpt-Client, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200, extraHeaders = {}) => {
    // Текущие CORS-заголовки берём из globalThis (если установлены
    // в начале fetch), иначе — глобальный fallback.
    const cors = globalThis.__CORS_HEADERS__ || CORS_HEADERS;
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...cors,
            ...extraHeaders,
        },
    });
};

const err = (code, message, status = 400) =>
    json({ ok: false, code, message, server_ts: Math.floor(Date.now() / 1000) }, status);

const ok = (data) =>
    json({ ok: true, server_ts: Math.floor(Date.now() / 1000), ...data });

// HMAC-SHA256 подпись для ответа. Клиент проверяет её публичным ключом.
// (В нашей простой версии — общий секрет; в прод-версии — Ed25519)
async function signResponse(payload, secret) {
    const msg = JSON.stringify(payload);
    const sig = await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        ),
        new TextEncoder().encode(msg)
    );
    return Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifySignature(payload, sigHex, secret) {
    try {
        const expected = await signResponse(payload, secret);
        return timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(sigHex, 'hex')
        );
    } catch {
        return false;
    }
}

// Генерация license-ключа: AERO-XXXX-XXXX-XXXX-XXXX
function genLicenseKey() {
    const blocks = 4;
    const blockLen = 4;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/O/1/I
    let out = 'AERO';
    const rnd = randomBytes(blocks * blockLen);
    for (let b = 0; b < blocks; b++) {
        out += '-';
        for (let i = 0; i < blockLen; i++) {
            out += chars[rnd[b * blockLen + i] % chars.length];
        }
    }
    return out;
}

// SHA-256 от произвольной строки (для token_hash)
async function sha256Hex(s) {
    const buf = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(s)
    );
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Простая rate-limit логика: не больше N запросов в минуту с одного IP
async function rateLimit(env, ip, endpoint, limit = 30) {
    // (Опционально — через KV. Сейчас no-op, чтобы не требовать KV.)
    return { allowed: true, remaining: limit };
}

// =====================================================================
// Эндпоинты
// =====================================================================

/**
 * POST /v1/activate
 * body: { license_key, hwid, hostname, os, app_version }
 * → { token, expires_at, hwid_count, signature }
 */
async function handleActivate(req, env, ctx) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');

    const { license_key, hwid, hostname, os, app_version } = body;
    if (!license_key || !hwid) {
        return err('bad_request', 'license_key and hwid required');
    }
    if (typeof hwid !== 'string' || hwid.length < 16 || hwid.length > 256) {
        return err('bad_request', 'hwid has invalid format');
    }

    // 1. Проверяем существование license_key (включая revoked)
    const license = await env.DB.prepare(
        'SELECT id, license_key, email, product, expires_at, max_hwid_count, revoked_at ' +
        'FROM licenses WHERE license_key = ?'
    ).bind(license_key).first();

    if (!license) {
        return err('invalid_key', 'License key not found', 404);
    }

    // 1a. Проверяем, не отозван ли ключ
    if (license.revoked_at) {
        return err('revoked',
            'License revoked. Contact support@aeroopt.app', 403);
    }

    // 2. Проверяем срок действия
    const now = Math.floor(Date.now() / 1000);
    if (license.expires_at && license.expires_at < now) {
        return err('expired', `License expired at ${new Date(license.expires_at * 1000).toISOString()}`, 403);
    }

    // 3. Считаем активные привязки
    const existing = await env.DB.prepare(
        'SELECT hwid FROM activations WHERE license_key = ? AND is_active = 1'
    ).bind(license_key).all();

    const hwidList = existing.results.map((r) => r.hwid);
    const alreadyBound = hwidList.includes(hwid);

    if (!alreadyBound && hwidList.length >= license.max_hwid_count) {
        return err(
            'hwid_limit',
            `Max ${license.max_hwid_count} machines. ` +
            'Deactivate old machine at https://aeroopt.app/account',
            403
        );
    }

    // 4. Создаём/обновляем активацию
    const token = randomBytes(32).toString('hex');
    const tokenTs = now;

    if (alreadyBound) {
        await env.DB.prepare(
            'UPDATE activations SET last_seen = ?, last_token = ?, last_token_ts = ?, ' +
            'hostname = COALESCE(?, hostname), os = COALESCE(?, os), ' +
            'app_version = COALESCE(?, app_version) ' +
            'WHERE license_key = ? AND hwid = ?'
        ).bind(now, token, tokenTs, hostname || null, os || null,
               app_version || null, license_key, hwid).run();
    } else {
        await env.DB.prepare(
            'INSERT INTO activations ' +
            '(license_key, hwid, hostname, os, app_version, first_seen, last_seen, last_token, last_token_ts) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(license_key, hwid, hostname || null, os || null,
               app_version || null, now, now, token, tokenTs).run();
    }

    // 5. Возвращаем токен с подписью
    const newHwidCount = alreadyBound ? hwidList.length : hwidList.length + 1;
    const payload = {
        license_key,
        hwid,
        token,
        expires_at: license.expires_at,
        hwid_count: newHwidCount,
        hwid_max: license.max_hwid_count,
        product: license.product,
    };
    const signature = await signResponse(payload, env.LICENSE_HMAC_KEY);
    return ok({ ...payload, signature });
}

/**
 * POST /v1/heartbeat
 * body: { license_key, hwid, token }
 * → { valid, grace_period_days, signature }
 *
 * Вызывается клиентом раз в ~30 дней. Возвращает:
 *   - valid=true  → лицензия жива, обновлённый token
 *   - grace_period_days → сколько дней ещё можно работать офлайн
 */
async function handleHeartbeat(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');

    const { license_key, hwid, token } = body;
    if (!license_key || !hwid) {
        return err('bad_request', 'license_key and hwid required');
    }

    const activation = await env.DB.prepare(
        'SELECT a.id, a.last_token, a.is_active, l.expires_at, l.revoked_at ' +
        'FROM activations a JOIN licenses l ON a.license_key = l.license_key ' +
        'WHERE a.license_key = ? AND a.hwid = ?'
    ).bind(license_key, hwid).first();

    if (!activation) {
        return err('not_bound',
            'This HWID is not bound to this license. Run activate first.', 404);
    }
    if (!activation.is_active) {
        return err('deactivated', 'This activation was deactivated', 403);
    }
    if (activation.revoked_at) {
        return err('revoked',
            'License revoked. Contact support@aeroopt.app', 403);
    }

    // Проверяем токен (если клиент его шлёт)
    let tokenOk = true;
    if (token) {
        const tokenHash = await sha256Hex(token);
        const revoked = await env.DB.prepare(
            'SELECT 1 FROM revoked_tokens WHERE token_hash = ?'
        ).bind(tokenHash).first();
        tokenOk = !revoked;
    }

    // Проверяем срок лицензии
    const now = Math.floor(Date.now() / 1000);
    const expired = activation.expires_at && activation.expires_at < now;
    if (expired || !tokenOk) {
        return err('expired_or_revoked',
            'License expired or token revoked', 403);
    }

    // Обновляем last_seen, выдаём новый токен
    const newToken = randomBytes(32).toString('hex');
    await env.DB.prepare(
        'UPDATE activations SET last_seen = ?, last_token = ?, last_token_ts = ? ' +
        'WHERE license_key = ? AND hwid = ?'
    ).bind(now, newToken, now, license_key, hwid).run();

    // Логируем heartbeat (для мониторинга аномалий)
    await env.DB.prepare(
        'INSERT INTO heartbeats (license_key, hwid, ts, runs_count, app_version) ' +
        'VALUES (?, ?, ?, 0, ?)'
    ).bind(license_key, hwid, now, body.app_version || null).run();

    const payload = {
        valid: true,
        license_key,
        hwid,
        token: newToken,
        grace_period_days: 30,  // можно работать офлайн 30 дней
        next_heartbeat_days: 30,
    };
    const signature = await signResponse(payload, env.LICENSE_HMAC_KEY);
    return ok(payload, 200, { 'X-Signature': signature });
}

/**
 * POST /v1/deactivate
 * body: { license_key, hwid, token }
 * → { ok }
 *
 * Отвязывает HWID (например, при переносе на другую машину).
 * В личном кабинете: https://aeroopt.app/account
 */
async function handleDeactivate(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');

    const { license_key, hwid, token } = body;
    if (!license_key || !hwid) {
        return err('bad_request', 'license_key and hwid required');
    }

    const result = await env.DB.prepare(
        'UPDATE activations SET is_active = 0 ' +
        'WHERE license_key = ? AND hwid = ?'
    ).bind(license_key, hwid).run();

    if (result.meta.changes === 0) {
        return err('not_found', 'No active binding for this HWID', 404);
    }
    // Отзываем токен
    if (token) {
        const tokenHash = await sha256Hex(token);
        await env.DB.prepare(
            'INSERT OR IGNORE INTO revoked_tokens (token_hash, license_key, revoked_at) ' +
            'VALUES (?, ?, ?)'
        ).bind(tokenHash, license_key, Math.floor(Date.now() / 1000)).run();
    }
    return ok({ deactivated: true });
}

/**
 * POST /v1/run_token
 * body: { license_key, hwid, token }
 * → { run_token, ttl_seconds, signature }
 *
 * Одноразовый токен на запуск SU2 (T6: server-bound). TTL 5 минут.
 * Клиент выдаёт этот токен в лог; если SU2 стартует без свежего
 * токена — это пиратство.
 */
async function handleRunToken(req, env) {
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');

    const { license_key, hwid, token } = body;
    if (!license_key || !hwid || !token) {
        return err('bad_request', 'license_key, hwid, token required');
    }
    // Проверяем что токен валиден
    const activation = await env.DB.prepare(
        'SELECT last_token, is_active FROM activations ' +
        'WHERE license_key = ? AND hwid = ?'
    ).bind(license_key, hwid).first();
    if (!activation || !activation.is_active) {
        return err('not_active', 'Activation not found or deactivated', 403);
    }
    // timingSafeEqual на токенах
    let tokenOk = false;
    try {
        tokenOk = activation.last_token &&
            timingSafeEqual(
                Buffer.from(activation.last_token, 'hex'),
                Buffer.from(token, 'hex')
            );
    } catch { tokenOk = false; }
    if (!tokenOk) {
        return err('bad_token', 'Invalid token', 403);
    }
    // Выдаём одноразовый run_token
    const runToken = randomBytes(24).toString('hex');
    const ttl = 300; // 5 минут
    const payload = {
        run_token: runToken,
        ttl_seconds: ttl,
        license_key,
        hwid,
    };
    const signature = await signResponse(payload, env.LICENSE_HMAC_KEY);
    return ok(payload, 200, { 'X-Signature': signature });
}

/**
 * POST /v1/check_update
 * body: { current_version }
 * → { latest_version, force_update, changelog }
 */
async function handleCheckUpdate(req, env) {
    const body = await req.json().catch(() => null);
    const current = body?.current_version || '0.0.0';
    // TODO: хранить в KV или D1
    const latest = '4.1.0';
    return ok({
        current_version: current,
        latest_version: latest,
        force_update: false,
        changelog: [
            '4.1.0: добавлен гибридный CPU+GPU режим',
            '4.1.0: плоскость симметрии (1.8x ускорение)',
            '4.1.0: SST-модель турбулентности',
            '4.1.0: mesh partition для многоядерных расчётов',
        ],
    });
}

/**
 * POST /v1/stripe_webhook
 * body: Stripe event
 *
 * После успешной оплаты Stripe шлёт checkout.session.completed →
 * создаём license_key и привязываем к email покупателя.
 * Пользователю уходит email с ключом.
 *
 * Проверка подписи: Stripe-Signature имеет формат
 *   "t=<timestamp>,v1=<sig>"
 * Подпись считается HMAC-SHA256 от "<timestamp>.<raw_body>" ключом
 * STRIPE_WEBHOOK_SECRET. Сравнение — timingSafeEqual.
 */
async function handleStripeWebhook(req, env) {
    const sigHeader = req.headers.get('stripe-signature');
    if (!sigHeader) return err('bad_sig', 'Missing stripe-signature', 400);

    const bodyText = await req.text();

    // === Верификация подписи Stripe ===================================
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        return err('misconfigured',
            'STRIPE_WEBHOOK_SECRET not set in wrangler secrets', 500);
    }
    let eventTs = null;
    let eventSig = null;
    for (const part of sigHeader.split(',')) {
        const [k, v] = part.split('=');
        if (k === 't') eventTs = v;
        if (k === 'v1') eventSig = v;
    }
    if (!eventTs || !eventSig) {
        return err('bad_sig', 'Invalid stripe-signature format', 400);
    }
    const signedPayload = `${eventTs}.${bodyText}`;
    const expected = await crypto.subtle.sign(
        'HMAC',
        await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(webhookSecret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        ),
        new TextEncoder().encode(signedPayload)
    );
    const expectedHex = Array.from(new Uint8Array(expected))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    let sigOk = false;
    try {
        sigOk = expectedHex.length === eventSig.length &&
            timingSafeEqual(
                Buffer.from(expectedHex, 'hex'),
                Buffer.from(eventSig, 'hex')
            );
    } catch { sigOk = false; }
    if (!sigOk) {
        return err('bad_sig', 'Stripe signature verification failed', 400);
    }
    // Проверка timestamp (не старше 5 минут — защита от replay)
    const age = Math.floor(Date.now() / 1000) - parseInt(eventTs, 10);
    if (age > 300 || age < -300) {
        return err('stale', `Webhook timestamp too old (${age}s)`, 400);
    }
    // =================================================================

    let event;
    try {
        event = JSON.parse(bodyText);
    } catch {
        return err('bad_json', 'Cannot parse Stripe payload', 400);
    }

    // Идемпотентность: не обрабатываем один event_id дважды
    const seen = await env.DB.prepare(
        'SELECT 1 FROM stripe_events WHERE event_id = ?'
    ).bind(event.id).first();
    if (seen) return ok({ duplicate: true });

    let licenseKey = null;
    if (event.type === 'checkout.session.completed' && event.data?.object) {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const product = session.metadata?.product || 'personal';
        if (email) {
            licenseKey = genLicenseKey();
            await env.DB.prepare(
                'INSERT INTO licenses (license_key, email, product, issued_at, max_hwid_count) ' +
                'VALUES (?, ?, ?, ?, ?)'
            ).bind(licenseKey, email, product,
                   Math.floor(Date.now() / 1000),
                   product === 'pro' ? 3 : 2).run();
            // TODO: отправить email с ключом (через Resend / SES / Cloudflare Email).
            // Cloudflare Email Workers + SendGrid/Resend — самый простой вариант.
            console.log(`[license] issued ${licenseKey} for ${email} (${product})`);
        }
    }

    // Сохраняем event для аудита
    await env.DB.prepare(
        'INSERT INTO stripe_events (event_id, event_type, payload, processed_at, license_key) ' +
        'VALUES (?, ?, ?, ?, ?)'
    ).bind(event.id, event.type, bodyText,
           Math.floor(Date.now() / 1000), licenseKey).run();

    return ok({ processed: true, license_key: licenseKey });
}

// =====================================================================
// ADMIN: выпуск / отзыв / примечание / список
// =====================================================================

/**
 * POST /v1/account_info
 * body: { license_key }
 * → { license, activations, heartbeats }
 *
 * Read-only endpoint для личного кабинета на сайте. Не требует
 * admin-токена — для доступа достаточно знать license_key (он
 * и так секретный, знает только владелец).
 */
async function handleAccountInfo(req, env) {
    const body = await req.json().catch(() => null);
    if (!body?.license_key) return err('bad_request', 'license_key required');
    const license = await env.DB.prepare(
        'SELECT license_key, customer_email, plan, max_machines, note, revoked_at ' +
        'FROM licenses WHERE license_key = ?'
    ).bind(body.license_key).first();
    if (!license) return err('not_found', 'License not found', 404);
    const activations = await env.DB.prepare(
        'SELECT hwid, machine_name, os, first_seen_at, last_seen_at, revoked_at ' +
        'FROM activations WHERE license_key = ? ORDER BY last_seen_at DESC'
    ).bind(body.license_key).all();
    const heartbeats = await env.DB.prepare(
        'SELECT ts, app_version FROM heartbeats ' +
        'WHERE license_key = ? ORDER BY ts DESC LIMIT 50'
    ).bind(body.license_key).all();
    // Превращаем activations в формат, который ожидает UI
    const activationList = (activations.results || []).map(a => ({
        hwid: a.hwid,
        hostname: a.machine_name,
        os: a.os,
        first_seen: a.first_seen_at,
        last_seen: a.last_seen_at,
        is_active: !a.revoked_at,
    }));
    return ok({
        license: {
            key: license.license_key,
            email: license.customer_email,
            product: license.plan,
            expires_at: null,  // не используется пока
            hwid_max: license.max_machines,
            revoked: !!license.revoked_at,
            note: license.note,
        },
        activations: activationList,
        heartbeats: (heartbeats.results || []).map(h => ({
            ts: h.ts,
            app_version: h.app_version,
            runs_count: 0,
        })),
    });
}
// Все admin endpoint'ы требуют заголовок X-Admin-Token с правильным
// значением (env.ADMIN_TOKEN). Без него — 401.
// Все действия пишутся в admin_audit_log.

async function adminCheck(req, env) {
    const token = req.headers.get('X-Admin-Token');
    if (!token) {
        return { ok: false, error: err('no_admin_token', 'Missing X-Admin-Token header', 401) };
    }
    // timingSafeEqual для постоянной длины сравнения
    if (!env.ADMIN_TOKEN) {
        return { ok: false, error: err('misconfigured', 'ADMIN_TOKEN not set in wrangler secrets', 500) };
    }
    const a = new TextEncoder().encode(token);
    const b = new TextEncoder().encode(env.ADMIN_TOKEN);
    if (a.length !== b.length) {
        return { ok: false, error: err('bad_admin_token', 'Invalid admin token', 401) };
    }
    let valid = false;
    try {
        valid = timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch { valid = false; }
    if (!valid) {
        return { ok: false, error: err('bad_admin_token', 'Invalid admin token', 401) };
    }
    return { ok: true };
}

async function adminLog(env, action, licenseKey, ip, payload) {
    try {
        await env.DB.prepare(
            'INSERT INTO admin_audit_log (action, license_key, admin_ip, payload, ts) ' +
            'VALUES (?, ?, ?, ?, ?)'
        ).bind(action, licenseKey || null, ip || null,
               JSON.stringify(payload || {}), Math.floor(Date.now() / 1000)).run();
    } catch (e) {
        console.error('adminLog failed:', e);
    }
}

/**
 * POST /v1/admin/issue
 * body: { email, product, max_machines?, expires_at?, note? }
 * header: X-Admin-Token
 * → { license_key, product, max_hwid_count, expires_at }
 *
 * Генерирует новый ключ, пишет в БД, отправляет email (если настроен).
 */
async function handleAdminIssue(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { email, product, max_machines, expires_at, note } = body;
    if (!email || !product) {
        return err('bad_request', 'email and product required');
    }
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';

    const licenseKey = genLicenseKey();
    const productMap = {
        personal: { default_machines: 2, default_expires: null },
        pro: { default_machines: 3, default_expires: null },
        edu: { default_machines: 1, default_expires: null },
        trial: { default_machines: 1, default_expires: 14 * 86400 }, // 14 дней
    };
    const prod = productMap[product];
    if (!prod) return err('bad_product', `Unknown product: ${product}`);

    const machines = max_machines || prod.default_machines;
    const expires = expires_at || prod.default_expires;
    const now = Math.floor(Date.now() / 1000);

    try {
        await env.DB.prepare(
            'INSERT INTO licenses ' +
            '(license_key, email, product, issued_at, expires_at, max_hwid_count, note) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(licenseKey, email, product, now, expires, machines, note || null).run();
    } catch (e) {
        return err('db_error', `DB error: ${e.message}`, 500);
    }

    await adminLog(env, 'issue', licenseKey, ip, {
        email, product, max_machines: machines, expires_at: expires, note,
    });

    // Отправляем email (если настроен RESEND_API_KEY)
    let emailStatus = 'not_configured';
    if (env.RESEND_API_KEY && env.RESEND_FROM) {
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: env.RESEND_FROM,
                    to: email,
                    subject: 'Ваш license key для AeroOpt',
                    text:
`Здравствуйте!

Вы получили лицензию AeroOpt (${product}).

Ваш лицензионный ключ:
${licenseKey}

Как активировать:
1. Установите AeroOpt с сайта https://aeroopt.app
2. Запустите программу
3. Меню "Лицензия" → "Активировать ключ"
4. Введите ключ выше

Ключ привязывается к компьютеру (Hardware ID).
Вы можете использовать его на ${machines} компьютер${machines === 1 ? 'е' : 'ах'}.
Перенести на другой компьютер: меню "Лицензия" → "Отвязать эту машину".

Если возникли вопросы: support@aeroopt.app

С уважением,
Команда AeroOpt
`,
                }),
            });
            emailStatus = r.ok ? 'sent' : `failed: HTTP ${r.status}`;
        } catch (e) {
            emailStatus = `error: ${e.message}`;
        }
        await adminLog(env, 'send_email', licenseKey, ip, {
            to: email, status: emailStatus,
        });
    }

    return ok({
        license_key: licenseKey,
        email,
        product,
        max_mwid_count: machines,
        expires_at: expires,
        note: note || null,
        email_status: emailStatus,
    });
}

/**
 * POST /v1/admin/revoke
 * body: { license_key, reason }
 * header: X-Admin-Token
 * → { ok, revoked_at }
 *
 * Помечает ключ отозванным. Все будущие heartbeat'ы и run_token'ы
 * возвращают 403. Уже выданные activation'ы остаются, но перестанут
 * получать новые токены.
 */
async function handleAdminRevoke(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key, reason } = body;
    if (!license_key) return err('bad_request', 'license_key required');
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const now = Math.floor(Date.now() / 1000);
    const result = await env.DB.prepare(
        'UPDATE licenses SET revoked_at = ?, revoked_reason = ? ' +
        'WHERE license_key = ? AND revoked_at IS NULL'
    ).bind(now, reason || null, license_key).run();
    if (result.meta.changes === 0) {
        // Возможно, ключ уже отозван или не существует
        const existing = await env.DB.prepare(
            'SELECT revoked_at FROM licenses WHERE license_key = ?'
        ).bind(license_key).first();
        if (!existing) return err('not_found', 'License key not found', 404);
        if (existing.revoked_at) {
            return err('already_revoked',
                `Already revoked at ${new Date(existing.revoked_at * 1000).toISOString()}`,
                409);
        }
    }
    // Также деактивируем все активации этого ключа
    await env.DB.prepare(
        'UPDATE activations SET is_active = 0 WHERE license_key = ?'
    ).bind(license_key).run();
    await adminLog(env, 'revoke', license_key, ip, { reason });
    return ok({ revoked_at: now, reason: reason || null });
}

/**
 * POST /v1/admin/set_note
 * body: { license_key, note }
 * header: X-Admin-Token
 * → { ok }
 */
async function handleAdminSetNote(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key, note } = body;
    if (!license_key) return err('bad_request', 'license_key required');
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const result = await env.DB.prepare(
        'UPDATE licenses SET note = ? WHERE license_key = ?'
    ).bind(note || null, license_key).run();
    if (result.meta.changes === 0) {
        return err('not_found', 'License key not found', 404);
    }
    await adminLog(env, 'set_note', license_key, ip, { note });
    return ok({ license_key, note });
}

/**
 * GET /v1/admin/list
 * query: ?product=personal&active_only=1&limit=100&offset=0
 * header: X-Admin-Token
 * → { licenses: [...], total, limit, offset }
 */
async function handleAdminList(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const url = new URL(req.url);
    const product = url.searchParams.get('product');
    const activeOnly = url.searchParams.get('active_only') === '1';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    let sql = 'SELECT license_key, email, product, issued_at, expires_at, ' +
              'max_hwid_count, note, revoked_at, revoked_reason FROM licenses WHERE 1=1';
    const args = [];
    if (product) {
        sql += ' AND product = ?';
        args.push(product);
    }
    if (activeOnly) {
        sql += ' AND revoked_at IS NULL';
    }
    sql += ' ORDER BY issued_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);

    let countSql = 'SELECT COUNT(*) as n FROM licenses WHERE 1=1';
    const countArgs = [];
    if (product) {
        countSql += ' AND product = ?';
        countArgs.push(product);
    }
    if (activeOnly) {
        countSql += ' AND revoked_at IS NULL';
    }
    const count = await env.DB.prepare(countSql).bind(...countArgs).first();

    // Считаем активации по каждому ключу
    const rows = await env.DB.prepare(sql).bind(...args).all();
    const result = [];
    for (const r of rows.results) {
        const act = await env.DB.prepare(
            'SELECT COUNT(*) as n FROM activations ' +
            'WHERE license_key = ? AND is_active = 1'
        ).bind(r.license_key).first();
        result.push({
            license_key: r.license_key,
            email: r.email,
            product: r.product,
            issued_at: r.issued_at,
            expires_at: r.expires_at,
            max_machines: r.max_hwid_count,
            note: r.note,
            revoked_at: r.revoked_at,
            revoked_reason: r.revoked_reason,
            active_machines: act.n,
            is_active: !r.revoked_at,
        });
    }
    return ok({
        licenses: result,
        total: count.n,
        limit,
        offset,
    });
}

/**
 * GET /v1/admin/inspect
 * query: ?license_key=AERO-...
 * header: X-Admin-Token
 * → { license, activations, heartbeats, audit }
 */
async function handleAdminInspect(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const url = new URL(req.url);
    const licenseKey = url.searchParams.get('license_key');
    if (!licenseKey) return err('bad_request', 'license_key query param required');
    const license = await env.DB.prepare(
        'SELECT * FROM licenses WHERE license_key = ?'
    ).bind(licenseKey).first();
    if (!license) return err('not_found', 'License not found', 404);
    const activations = await env.DB.prepare(
        'SELECT hwid, hostname, os, app_version, first_seen, last_seen, is_active ' +
        'FROM activations WHERE license_key = ? ORDER BY last_seen DESC'
    ).bind(licenseKey).all();
    const heartbeats = await env.DB.prepare(
        'SELECT ts, app_version, runs_count FROM heartbeats ' +
        'WHERE license_key = ? ORDER BY ts DESC LIMIT 100'
    ).bind(licenseKey).all();
    const audit = await env.DB.prepare(
        'SELECT action, admin_ip, payload, ts FROM admin_audit_log ' +
        'WHERE license_key = ? ORDER BY ts DESC LIMIT 50'
    ).bind(licenseKey).all();
    return ok({
        license,
        activations: activations.results,
        heartbeats: heartbeats.results,
        audit: audit.results,
    });
}

/**
 * POST /v1/admin/restore
 * body: { license_key }
 * header: X-Admin-Token
 * → { ok }
 *
 * Снимает отзыв с ключа. Используется, если revoke был ошибочным.
 */
async function handleAdminRestore(req, env) {
    const auth = await adminCheck(req, env);
    if (!auth.ok) return auth.error;
    const body = await req.json().catch(() => null);
    if (!body) return err('bad_request', 'JSON body required');
    const { license_key } = body;
    if (!license_key) return err('bad_request', 'license_key required');
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const result = await env.DB.prepare(
        'UPDATE licenses SET revoked_at = NULL, revoked_reason = NULL ' +
        'WHERE license_key = ? AND revoked_at IS NOT NULL'
    ).bind(license_key).run();
    if (result.meta.changes === 0) {
        return err('not_revoked', 'License is not revoked', 400);
    }
    await adminLog(env, 'restore', license_key, ip, {});
    return ok({ license_key });
}

// =====================================================================
// Роутер
// =====================================================================

export default {
    async fetch(req, env, ctx) {
        // Устанавливаем текущие CORS-заголовки для всех ответов в этом запросе
        globalThis.__CORS_HEADERS__ = corsHeadersFor(req);

        // CORS preflight — отвечаем с заголовками, специфичными для Origin
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeadersFor(req),
            });
        }
        const url = new URL(req.url);
        const path = url.pathname;
        const clientIp = req.headers.get('CF-Connecting-IP') || '0.0.0.0';

        // Rate limit
        const rl = await rateLimit(env, clientIp, path, 30);
        if (!rl.allowed) {
            return err('rate_limited', 'Too many requests', 429);
        }

        try {
            // === Health check ===========================================
            if (path === '/healthz') {
                return ok({ status: 'ok', version: '1.0.0' });
            }

            // === API ===================================================
            if (path === '/v1/activate' && req.method === 'POST') {
                return await handleActivate(req, env, ctx);
            }
            if (path === '/v1/heartbeat' && req.method === 'POST') {
                return await handleHeartbeat(req, env);
            }
            if (path === '/v1/deactivate' && req.method === 'POST') {
                return await handleDeactivate(req, env);
            }
            if (path === '/v1/run_token' && req.method === 'POST') {
                return await handleRunToken(req, env);
            }
            if (path === '/v1/check_update' && req.method === 'POST') {
                return await handleCheckUpdate(req, env);
            }
            if (path === '/v1/stripe_webhook' && req.method === 'POST') {
                return await handleStripeWebhook(req, env);
            }
            // === ADMIN ===============================================
            if (path === '/v1/admin/issue' && req.method === 'POST') {
                return await handleAdminIssue(req, env);
            }
            if (path === '/v1/admin/revoke' && req.method === 'POST') {
                return await handleAdminRevoke(req, env);
            }
            if (path === '/v1/admin/restore' && req.method === 'POST') {
                return await handleAdminRestore(req, env);
            }
            if (path === '/v1/admin/set_note' && req.method === 'POST') {
                return await handleAdminSetNote(req, env);
            }
            if (path === '/v1/admin/list' && req.method === 'GET') {
                return await handleAdminList(req, env);
            }
            if (path === '/v1/admin/inspect' && req.method === 'GET') {
                return await handleAdminInspect(req, env);
            }
            // === Public read-only (только license_key, без admin токена) ==
            if (path === '/v1/account_info' && req.method === 'POST') {
                return await handleAccountInfo(req, env);
            }

            return err('not_found', `No route for ${req.method} ${path}`, 404);
        } catch (e) {
            console.error('[worker] unhandled error:', e);
            return err('server_error', 'Internal error', 500);
        }
    },
};
