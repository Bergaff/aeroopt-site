#!/usr/bin/env node
/**
 * admin_cli.js — управление лицензиями AeroOpt.
 *
 * Использование:
 *   ADMIN_TOKEN=xxx node admin_cli.js issue \
 *       --email student@mit.edu \
 *       --product edu \
 *       --max-machines 1 \
 *       --note "Студент МФТИ, диплом"
 *
 *   node admin_cli.js list [--product edu] [--active-only] [--limit 50]
 *   node admin_cli.js inspect AERO-XXXX-XXXX-XXXX-XXXX
 *   node admin_cli.js revoke AERO-XXXX-XXXX-XXXX-XXXX --reason "Запрос на возврат"
 *   node admin_cli.js restore AERO-XXXX-XXXX-XXXX-XXXX
 *   node admin_cli.js note AERO-XXXX-XXXX-XXXX-XXXX --note "новое примечание"
 *
 * Переменные окружения:
 *   LICENSE_SERVER  — URL воркера (default: https://aeroopt-license-server.tgmg.workers.dev)
 *   ADMIN_TOKEN     — токен из `wrangler secret put ADMIN_TOKEN`
 */

const fs = require('fs');
const path = require('path');

const SERVER = process.env.LICENSE_SERVER ||
    'https://aeroopt-license-server.tgmg.workers.dev';
const TOKEN = process.env.ADMIN_TOKEN;

if (!TOKEN) {
    // Попробуем прочитать из .env файла рядом
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, 'utf-8');
        const m = env.match(/^ADMIN_TOKEN=(.+)$/m);
        if (m) process.env.ADMIN_TOKEN = m[1].trim();
    }
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
    console.error('❌ ADMIN_TOKEN не задан.');
    console.error('   Задайте через переменную окружения:');
    console.error('     export ADMIN_TOKEN=ваш_токен');
    console.error('   или создайте .env файл:');
    console.error('     ADMIN_TOKEN=ваш_токен');
    console.error('   Токен берётся из `wrangler secret put ADMIN_TOKEN`.');
    process.exit(1);
}

// =====================================================================
// HTTP
// =====================================================================
async function api(method, path, body) {
    const url = `${SERVER}${path}`;
    const headers = {
        'X-Admin-Token': ADMIN_TOKEN,
        'User-Agent': 'AeroOpt-admin_cli/1.0',
    };
    const init = { method, headers };
    if (body) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    let data;
    try {
        data = await r.json();
    } catch (e) {
        console.error(`❌ ${r.status} ${r.statusText}`);
        console.error('   Ответ не JSON. Проверьте URL и токен.');
        process.exit(2);
    }
    if (!data.ok) {
        console.error(`❌ ${r.status} ${data.code || ''}: ${data.message || ''}`);
        process.exit(3);
    }
    return data;
}

// =====================================================================
// Утилиты
// =====================================================================
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith('--')
                ? argv[++i] : true;
            args[key] = val;
        }
    }
    return args;
}

function fmtDate(unix) {
    if (!unix) return '—';
    return new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function fmtKey(k) {
    return k.slice(0, 4) + '...' + k.slice(-4);
}

function printTable(licenses) {
    if (licenses.length === 0) {
        console.log('   (нет ключей)');
        return;
    }
    const rows = [
        ['KEY', 'EMAIL', 'PROD', 'STATUS', 'MACH', 'ISSUED'],
        ...licenses.map(l => [
            fmtKey(l.license_key),
            (l.email || '').slice(0, 28),
            l.product,
            l.is_active
                ? (l.expires_at && l.expires_at < Math.floor(Date.now() / 1000)
                    ? 'EXPIRED' : 'ACTIVE')
                : 'REVOKED',
            `${l.active_machines || 0}/${l.max_machines}`,
            fmtDate(l.issued_at),
        ]),
    ];
    const widths = rows[0].map((_, i) =>
        Math.max(...rows.map(r => (r[i] || '').length))
    );
    for (const row of rows) {
        console.log('   ' + row.map((c, i) =>
            (c || '').padEnd(widths[i])).join('  '));
    }
}

// =====================================================================
// Команды
// =====================================================================
async function cmdIssue(args) {
    if (!args.email || !args.product) {
        console.error('❌ --email и --product обязательны');
        console.error('   Пример: --email student@mit.edu --product edu');
        process.exit(1);
    }
    const product = String(args.product).toLowerCase();
    const validProducts = ['personal', 'pro', 'edu', 'trial'];
    if (!validProducts.includes(product)) {
        console.error(`❌ --product должен быть одним из: ${validProducts.join(', ')}`);
        process.exit(1);
    }
    const body = {
        email: args.email,
        product,
        max_machines: args['max-machines'] ? parseInt(args['max-machines']) : undefined,
        expires_in_days: args['expires-days'] ? parseInt(args['expires-days']) : undefined,
        note: args.note,
    };
    console.log(`⏳ Генерирую ключ для ${args.email} (${product})...`);
    const result = await api('POST', '/v1/admin/issue', body);
    console.log('');
    console.log('✅ Ключ выдан:');
    console.log(`   License key: ${result.license_key}`);
    console.log(`   Email:       ${result.email}`);
    console.log(`   Product:     ${result.product}`);
    console.log(`   Machines:    ${result.max_machines ?? result.max_hwid_count}`);
    console.log(`   Expires:     ${result.expires_at ? fmtDate(result.expires_at) : 'бессрочно'}`);
    if (result.note) console.log(`   Note:        ${result.note}`);
    console.log(`   Email:       ${result.email_status}`);
}

async function cmdList(args) {
    const params = new URLSearchParams();
    if (args.product) params.set('product', args.product);
    if (args['active-only']) params.set('active_only', '1');
    if (args.limit) params.set('limit', String(parseInt(args.limit)));
    if (args.offset) params.set('offset', String(parseInt(args.offset)));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const result = await api('GET', `/v1/admin/list${qs}`);
    console.log(`📋 Лицензии (${result.licenses.length} из ${result.total}):`);
    console.log('');
    printTable(result.licenses);
    if (result.licenses.length > 0) {
        console.log('');
        console.log('Подробности: node admin_cli.js inspect <license_key>');
    }
}

async function cmdInspect(args) {
    const key = args._ && args._[0];
    if (!key) {
        console.error('❌ Укажите license_key:');
        console.error('   node admin_cli.js inspect AERO-XXXX-XXXX-XXXX-XXXX');
        process.exit(1);
    }
    const result = await api('GET', `/v1/admin/inspect?license_key=${encodeURIComponent(key)}`);
    const l = result.license;
    console.log(`📋 License ${l.license_key}:`);
    console.log(`   Email:       ${l.email}`);
    console.log(`   Product:     ${l.product}`);
    console.log(`   Issued:      ${fmtDate(l.issued_at)}`);
    console.log(`   Expires:     ${l.expires_at ? fmtDate(l.expires_at) : 'бессрочно'}`);
    console.log(`   Machines:    ${l.max_machines ?? l.max_hwid_count}`);
    console.log(`   Revoked:     ${l.revoked_at ? fmtDate(l.revoked_at) : 'нет'}`);
    if (l.revoked_reason) console.log(`   Revoke reason: ${l.revoked_reason}`);
    if (l.note) console.log(`   Note:        ${l.note}`);
    console.log('');
    console.log(`   Активации (${result.activations.length}):`);
    for (const a of result.activations) {
        const status = a.is_active ? '✓' : '✗';
        console.log(`     ${status} ${(a.hostname || '?').padEnd(20)} ${(a.os || '').slice(0, 30).padEnd(30)} ${fmtDate(a.last_seen)}`);
    }
    console.log('');
    console.log(`   Heartbeats (последние ${result.heartbeats.length}):`);
    for (const h of result.heartbeats.slice(0, 5)) {
        console.log(`     ${fmtDate(h.ts)} v${h.app_version} runs=${h.runs_count}`);
    }
    if (result.heartbeats.length > 5) {
        console.log(`     ... и ещё ${result.heartbeats.length - 5}`);
    }
    console.log('');
    console.log(`   Audit log (${result.audit.length}):`);
    for (const e of result.audit) {
        console.log(`     [${fmtDate(e.ts)}] ${e.action.padEnd(12)} ${e.admin_ip || '?'}`);
    }
}

async function cmdRevoke(args) {
    const key = args._ && args._[0];
    if (!key) {
        console.error('❌ Укажите license_key:');
        console.error('   node admin_cli.js revoke AERO-XXXX-XXXX-XXXX-XXXX --reason "..."');
        process.exit(1);
    }
    const body = { license_key: key, reason: args.reason || null };
    const result = await api('POST', '/v1/admin/revoke', body);
    console.log(`✅ Ключ ${fmtKey(key)} отозван.`);
    console.log(`   Revoked at: ${fmtDate(result.revoked_at)}`);
    console.log(`   Reason:      ${result.reason || '—'}`);
}

async function cmdRestore(args) {
    const key = args._ && args._[0];
    if (!key) {
        console.error('❌ Укажите license_key:');
        console.error('   node admin_cli.js restore AERO-XXXX-XXXX-XXXX-XXXX');
        process.exit(1);
    }
    await api('POST', '/v1/admin/restore', { license_key: key });
    console.log(`✅ Ключ ${fmtKey(key)} восстановлен.`);
}

async function cmdNote(args) {
    const key = args._ && args._[0];
    if (!key || !args.note) {
        console.error('❌ Укажите license_key и --note:');
        console.error('   node admin_cli.js note AERO-XXXX-... --note "Студент МФТИ"');
        process.exit(1);
    }
    await api('POST', '/v1/admin/set_note', {
        license_key: key,
        note: args.note,
    });
    console.log(`✅ Примечание для ${fmtKey(key)} обновлено.`);
}

// =====================================================================
// Help
// =====================================================================
function help() {
    console.log(`
AeroOpt admin CLI — управление лицензиями.

Команды:
  issue  --email <e> --product <personal|pro|edu|trial>
          [--max-machines N] [--expires-days D] [--note "..."]  выдать ключ
  list   [--product <p>] [--active-only]        список ключей
          [--limit N] [--offset N]
  inspect <license_key>                          детали по ключу
  revoke <license_key> --reason "..."            отозвать
  restore <license_key>                          снять отзыв
  note <license_key> --note "..."                обновить примечание

Примеры:
  export ADMIN_TOKEN=ваш_токен_из_wrangler
  node admin_cli.js issue --email test@x.com --product personal
  node admin_cli.js list
  node admin_cli.js inspect AERO-XXXX-XXXX-XXXX-XXXX
  node admin_cli.js revoke AERO-XXXX-XXXX-XXXX-XXXX --reason "возврат"
  node admin_cli.js note AERO-XXXX-XXXX-XXXX-XXXX --note "продлил до конца года"

Сервер: ${SERVER}
`);
}

// =====================================================================
// Точка входа
// =====================================================================
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        help();
        process.exit(0);
    }
    const cmd = argv[0];
    const args = parseArgs(argv.slice(1));
    args._ = argv.slice(1).filter(a => !a.startsWith('--'));

    try {
        switch (cmd) {
            case 'issue':   return await cmdIssue(args);
            case 'list':    return await cmdList(args);
            case 'inspect': return await cmdInspect(args);
            case 'revoke':  return await cmdRevoke(args);
            case 'restore': return await cmdRestore(args);
            case 'note':    return await cmdNote(args);
            case 'help':    return help();
            default:
                console.error(`❌ Неизвестная команда: ${cmd}`);
                help();
                process.exit(1);
        }
    } catch (e) {
        console.error('❌ Ошибка:', e.message);
        if (e.cause) console.error('   Причина:', e.cause.message);
        process.exit(99);
    }
}

main();
