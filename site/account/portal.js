/* AeroOpt — личный кабинет (vanilla JS, без зависимостей)
 *
 * API endpoints (см. license_server/src/worker.js):
 *   POST /v1/activate    — привязка HWID (с этого браузера не нужно, это из приложения)
 *   POST /v1/heartbeat   — ежемесячная проверка
 *   POST /v1/deactivate  — отвязка HWID
 *
 * В браузере мы НЕ привязываем HWID. Мы только:
 *   - показываем список активированных машин (через heartbeat с токеном
 *     одной из машин, но в браузере нет HWID — поэтому читаем инфу через
 *     специальный read-only endpoint).
 *
 * Для read-only доступа в браузере используется упрощённый эндпоинт
 * /v1/account_info, который принимает только license_key.
 * Этот endpoint нужно добавить в license_server/src/worker.js:
 *
 *     if (path === '/v1/account_info' && req.method === 'POST') {
 *         return await handleAccountInfo(req, env);
 *     }
 *
 *     async function handleAccountInfo(req, env) {
 *         const body = await req.json().catch(() => null);
 *         if (!body?.license_key) return err('bad_request', 'license_key required');
 *         const license = await env.DB.prepare(
 *             'SELECT license_key, email, product, expires_at, max_hwid_count ' +
 *             'FROM licenses WHERE license_key = ?'
 *         ).bind(body.license_key).first();
 *         if (!license) return err('not_found', 'License not found', 404);
 *         const activations = await env.DB.prepare(
 *             'SELECT hwid, hostname, os, app_version, first_seen, last_seen, is_active ' +
 *             'FROM activations WHERE license_key = ? ORDER BY last_seen DESC'
 *         ).bind(body.license_key).all();
 *         const heartbeats = await env.DB.prepare(
 *             'SELECT ts, app_version, runs_count FROM heartbeats ' +
 *             'WHERE license_key = ? AND ts > ? ORDER BY ts DESC LIMIT 50'
 *         ).bind(body.license_key, Math.floor(Date.now() / 1000) - 30 * 86400).all();
 *         return ok({
 *             license: {
 *                 key: license.license_key,
 *                 product: license.product,
 *                 expires_at: license.expires_at,
 *                 hwid_max: license.max_hwid_count,
 *             },
 *             activations: activations.results,
 *             heartbeats: heartbeats.results,
 *         });
 *     }
 *
 * Запросы deactivate с браузера тоже работают — нужно только знать hwid
 * конкретной машины (показываем в таблице).
 */

// Прод-домен (когда настроите api.aeroopt.app в Cloudflare Workers):
const API_BASE = "https://aeroopt-license-server.tgmg.workers.dev";
// Кастомный домен (после настройки в Cloudflare Workers):
// const API_BASE = "https://api.aeroopt.app";

// =====================================================================
// Storage: license_key в localStorage (для удобства, не критично)
// =====================================================================
const STORAGE_KEY = "aeroopt.license_key";

function getLicenseKey() {
    return localStorage.getItem(STORAGE_KEY) || "";
}

function setLicenseKey(key) {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
}

// =====================================================================
// HTTP helpers
// =====================================================================
async function apiPost(path, body) {
    const r = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    let data;
    try {
        data = await r.json();
    } catch (e) {
        throw new Error(`Сервер вернул невалидный JSON (HTTP ${r.status})`);
    }
    if (!data.ok) {
        throw new Error(data.message || data.code || `HTTP ${r.status}`);
    }
    return data;
}

function formatDate(unix) {
    if (!unix) return "—";
    const d = new Date(unix * 1000);
    return d.toISOString().slice(0, 16).replace("T", " ");
}

function productName(p) {
    return {
        personal: "Personal",
        pro: "Pro",
        edu: "Educational",
    }[p] || p || "—";
}

function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// =====================================================================
// Login
// =====================================================================
function showLogin() {
    document.getElementById("login-section").style.display = "";
    document.getElementById("dashboard-section").style.display = "none";
    document.getElementById("license-key").focus();
}

function showDashboard() {
    document.getElementById("login-section").style.display = "none";
    document.getElementById("dashboard-section").style.display = "";
}

async function doLogin() {
    const input = document.getElementById("license-key");
    const errBox = document.getElementById("login-error");
    const btn = document.getElementById("login-btn");
    const key = input.value.trim().toUpperCase();
    if (!key) {
        errBox.textContent = "Введите license_key.";
        errBox.style.display = "";
        return;
    }
    btn.disabled = true;
    errBox.style.display = "none";
    try {
        // Проверяем, что ключ существует, через account_info
        await apiPost("/v1/account_info", { license_key: key });
        setLicenseKey(key);
        await loadDashboard();
    } catch (e) {
        errBox.textContent = `Ошибка: ${e.message}`;
        errBox.style.display = "";
    } finally {
        btn.disabled = false;
    }
}

function doLogout() {
    setLicenseKey("");
    showLogin();
    document.getElementById("license-key").value = "";
}

// =====================================================================
// Dashboard
// =====================================================================
async function loadDashboard() {
    const key = getLicenseKey();
    if (!key) {
        showLogin();
        return;
    }
    try {
        const data = await apiPost("/v1/account_info", { license_key: key });
        renderDashboard(key, data);
        showDashboard();
    } catch (e) {
        // Ключ невалиден или истёк — разлогиниваем
        setLicenseKey("");
        showLogin();
        const errBox = document.getElementById("login-error");
        errBox.textContent = `Не удалось загрузить данные: ${e.message}`;
        errBox.style.display = "";
    }
}

function renderDashboard(key, data) {
    const lic = data.license || {};
    const activations = data.activations || [];
    const heartbeats = data.heartbeats || [];

    document.getElementById("d-license-key").textContent = key;
    document.getElementById("d-product").textContent = productName(lic.product);
    document.getElementById("d-hwid-count").textContent = activations.filter(a => a.is_active).length;
    document.getElementById("d-hwid-max").textContent = lic.hwid_max || 0;
    document.getElementById("d-expires").textContent = lic.expires_at
        ? formatDate(lic.expires_at)
        : "бессрочно";

    // Last seen = максимум last_seen среди активаций
    const lastSeen = activations
        .map(a => a.last_seen || 0)
        .reduce((m, x) => Math.max(m, x), 0);

    // === Grace period: показываем сколько дней осталось офлайн-режима ===
    // Клиент присылает last_heartbeat при каждом activate/heartbeat.
    // У нас в /v1/account_info такого поля нет — отображаем по last_seen
    // (примерно совпадает с реальным heartbeat).
    const now = Math.floor(Date.now() / 1000);
    const GRACE_DAYS = 30;
    const daysSinceSeen = lastSeen ? Math.floor((now - lastSeen) / 86400) : 999;
    const daysLeft = Math.max(0, GRACE_DAYS - daysSinceSeen);
    const lastSeenStr = lastSeen
        ? formatDate(lastSeen) + ` (офлайн-режим: осталось ~${daysLeft} дн.)`
        : "никогда";
    document.getElementById("d-last-seen").textContent = lastSeenStr;

    // Если отозван — показываем баннер
    if (lic.revoked) {
        const banner = document.createElement("p");
        banner.className = "note";
        banner.style.color = "var(--accent)";
        banner.style.fontWeight = "600";
        banner.textContent = "⛔ Эта лицензия отозвана. Свяжитесь с support@aeroopt.app.";
        document.querySelector("#dashboard-section h2").after(banner);
    }

    // Machines
    const tbody = document.getElementById("machines-tbody");
    const noMachines = document.getElementById("no-machines");
    const table = document.getElementById("machines-table");
    const machineErr = document.getElementById("machine-error");
    machineErr.style.display = "none";

    if (activations.length === 0) {
        noMachines.style.display = "";
        table.style.display = "none";
    } else {
        noMachines.style.display = "none";
        table.style.display = "";
        tbody.innerHTML = "";
        for (const a of activations) {
            const tr = document.createElement("tr");
            const hostname = a.hostname || "(неизвестно)";
            const hwidShort = a.hwid ? a.hwid.slice(0, 12) + "..." : "—";
            const os = a.os || "—";
            const lastSeenStr = a.last_seen ? formatDate(a.last_seen) : "—";
            const isActive = a.is_active ? "" : " (отвязана)";
            tr.innerHTML = `
                <td>${escapeHtml(hostname)}${isActive}</td>
                <td style="font-family: ui-monospace, monospace; font-size: 13px;">${escapeHtml(hwidShort)}</td>
                <td>${escapeHtml(os)}</td>
                <td>${escapeHtml(lastSeenStr)}</td>
                <td>
                    ${a.is_active ?
                        `<a href="#" data-hwid="${escapeHtml(a.hwid)}" class="deactivate-link">Отвязать</a>`
                        : ""}
                </td>
            `;
            tbody.appendChild(tr);
        }
        // Подключаем обработчики
        tbody.querySelectorAll(".deactivate-link").forEach(link => {
            link.addEventListener("click", (e) => {
                e.preventDefault();
                const hwid = link.getAttribute("data-hwid");
                if (hwid) deactivateMachine(key, hwid);
            });
        });
    }

    // Activity
    const noActivity = document.getElementById("no-activity");
    const actTable = document.getElementById("activity-table");
    const actTbody = document.getElementById("activity-tbody");
    if (heartbeats.length === 0) {
        noActivity.style.display = "";
        actTable.style.display = "none";
    } else {
        noActivity.style.display = "none";
        actTable.style.display = "";
        actTbody.innerHTML = "";
        for (const h of heartbeats) {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${escapeHtml(formatDate(h.ts))}</td>
                <td>${escapeHtml(h.app_version || "—")}</td>
                <td>${escapeHtml(String(h.runs_count || 0))}</td>
            `;
            actTbody.appendChild(tr);
        }
    }
}

async function deactivateMachine(key, hwid) {
    const machineErr = document.getElementById("machine-error");
    machineErr.style.display = "none";
    if (!confirm(
        "Отвязать эту машину от лицензии?\n\n" +
        "После этого приложение AeroOpt на этой машине " +
        "перестанет работать."
    )) {
        return;
    }
    try {
        // Для deactivate нужен валидный token. В браузере у нас его нет,
        // поэтому передаём пустой токен — сервер всё равно отвяжет.
        // (Или: добавьте в server эндпоинт deactivate_by_admin, который
        // принимает license_key + hwid и не требует токен, для веб-кабинета.)
        await apiPost("/v1/deactivate", {
            license_key: key,
            hwid: hwid,
            token: "",
        });
        await loadDashboard();
    } catch (e) {
        machineErr.textContent = `Ошибка отвязки: ${e.message}`;
        machineErr.style.display = "";
    }
}

// =====================================================================
// Init
// =====================================================================
document.addEventListener("DOMContentLoaded", () => {
    const key = getLicenseKey();
    if (key) {
        document.getElementById("license-key").value = key;
        loadDashboard();
    } else {
        showLogin();
    }

    document.getElementById("login-btn").addEventListener("click", doLogin);
    document.getElementById("license-key").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
    });
    document.getElementById("logout").addEventListener("click", (e) => {
        e.preventDefault();
        doLogout();
    });
    const logout2 = document.getElementById("logout-2");
    if (logout2) {
        logout2.addEventListener("click", (e) => {
            e.preventDefault();
            doLogout();
        });
    }
});
