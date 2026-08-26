/* AeroOpt admin panel — vanilla JS, без зависимостей.
 *
 * Хранит admin token в sessionStorage (не localStorage, чтобы при
 * закрытии вкладки не оставалось; для production-уровня — нужен
 * более серьёзный механизм, но для MVP достаточно).
 */

// Прод-домен (когда настроите api.aeroopt.app в Cloudflare Workers):
const API_BASE = "https://aeroopt-license-server.tgmg.workers.dev";
// На время разработки можно переключить на workers.dev:
// const API_BASE = "https://aeroopt-license-server.aeroopt.workers.dev";
const STORAGE_KEY = "aeroopt.admin_token";

// =====================================================================
// Storage
// =====================================================================
function getToken() {
    return sessionStorage.getItem(STORAGE_KEY) || "";
}

function setToken(t) {
    if (t) sessionStorage.setItem(STORAGE_KEY, t);
    else sessionStorage.removeItem(STORAGE_KEY);
}

// =====================================================================
// HTTP
// =====================================================================
async function adminApi(method, path, body) {
    const headers = {
        "X-Admin-Token": getToken(),
        "User-Agent": "AeroOpt-admin-web/1.0",
    };
    const init = { method, headers };
    if (body) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    const r = await fetch(API_BASE + path, init);
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

// =====================================================================
// Утилиты
// =====================================================================
function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function fmtDate(unix) {
    if (!unix) return "—";
    if (typeof unix === "string" && unix.includes("-") && !/^\d+$/.test(unix)) {
        return unix.slice(0, 10);
    }
    const n = Number(unix);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString().slice(0, 10);
}

function fmtKey(k) {
    if (!k) return "—";
    return k.slice(0, 4) + "…" + k.slice(-4);
}

function shortKey(k) {
    return `<code style="font-size: 12px;">${escapeHtml(k)}</code>`;
}

function statusBadge(l) {
    if (l.revoked_at) {
        return '<span style="color: var(--accent); font-weight: 600;">REVOKED</span>';
    }
    if (l.expires_at && l.expires_at < Math.floor(Date.now() / 1000)) {
        return '<span style="color: var(--accent);">EXPIRED</span>';
    }
    return '<span style="color: #1A8a3a;">ACTIVE</span>';
}

// =====================================================================
// Login
// =====================================================================
function showLogin() {
    document.getElementById("login-section").style.display = "";
    document.getElementById("dashboard-section").style.display = "none";
    document.getElementById("admin-token").focus();
}

function showDashboard() {
    document.getElementById("login-section").style.display = "none";
    document.getElementById("dashboard-section").style.display = "";
}

function doLogin() {
    const input = document.getElementById("admin-token");
    const errBox = document.getElementById("login-error");
    const t = input.value.trim().replace(/\r/g, "");
    if (!t) {
        errBox.textContent = "Введите ADMIN_TOKEN.";
        errBox.style.display = "";
        return;
    }
    setToken(t);
    errBox.style.display = "none";
    loadList().then(showDashboard).catch(e => {
        setToken("");
        errBox.textContent = `Ошибка: ${e.message}`;
        errBox.style.display = "";
    });
}

function doLogout() {
    setToken("");
    document.getElementById("admin-token").value = "";
    showLogin();
}

// =====================================================================
// Issue
// =====================================================================
async function submitIssue(e) {
    e.preventDefault();
    const email = document.getElementById("f-email").value.trim();
    const product = document.getElementById("f-product").value;
    const machinesVal = document.getElementById("f-machines").value;
    const note = document.getElementById("f-note").value.trim();
    if (!email) return;

    const body = { email, product };
    if (machinesVal) body.max_machines = parseInt(machinesVal);
    if (note) body.note = note;

    try {
        const data = await adminApi("POST", "/v1/admin/issue", body);
        const display = document.getElementById("issue-key-display");
        display.textContent = data.license_key;
        const meta = document.getElementById("issue-meta");
        meta.innerHTML = `
            Email: ${escapeHtml(data.email)}<br>
            Продукт: ${escapeHtml(data.product)}<br>
            Машин: ${data.max_mwid_count}<br>
            Email статус: ${escapeHtml(data.email_status)}
        `;
        document.getElementById("issue-result").style.display = "";
        // Сброс формы
        document.getElementById("f-email").value = "";
        document.getElementById("f-note").value = "";
        // Обновить список
        loadList();
    } catch (e) {
        alert("Ошибка выдачи: " + e.message);
    }
}

// =====================================================================
// List
// =====================================================================
async function loadList() {
    const errBox = document.getElementById("list-error");
    errBox.style.display = "none";
    const params = new URLSearchParams();
    const emailF = document.getElementById("filter-email").value.trim();
    const productF = document.getElementById("filter-product").value;
    const activeF = document.getElementById("filter-active").checked;
    if (productF) params.set("product", productF);
    if (activeF) params.set("active_only", "1");
    const qs = params.toString() ? `?${params.toString()}` : "";
    try {
        const data = await adminApi("GET", `/v1/admin/list${qs}`);
        const tbody = document.getElementById("licenses-tbody");
        const empty = document.getElementById("list-empty");
        const info = document.getElementById("list-info");
        tbody.innerHTML = "";
        // Фильтр по email — на клиенте (сервер не поддерживает)
        let filtered = data.licenses;
        if (emailF) {
            const lf = emailF.toLowerCase();
            filtered = filtered.filter(l => (l.email || "").toLowerCase().includes(lf));
        }
        info.textContent = `Показано ${filtered.length} из ${data.total} ключей.`;
        if (filtered.length === 0) {
            empty.style.display = "";
            return;
        }
        empty.style.display = "none";
        for (const l of filtered) {
            const tr = document.createElement("tr");
            const actions = l.revoked_at
                ? `<a href="#" data-action="restore" data-key="${escapeHtml(l.license_key)}">восстановить</a>`
                : `<a href="#" data-action="revoke" data-key="${escapeHtml(l.license_key)}">отозвать</a>`;
            tr.innerHTML = `
                <td>${shortKey(l.license_key)}</td>
                <td>${escapeHtml(l.email)}</td>
                <td>${escapeHtml(l.product)}</td>
                <td>${statusBadge(l)}</td>
                <td>${l.active_machines || 0} / ${l.max_machines}</td>
                <td>${fmtDate(l.issued_at)}</td>
                <td>${escapeHtml(l.note || "")}</td>
                <td>${actions} · <a href="#" data-action="note" data-key="${escapeHtml(l.license_key)}">прим.</a></td>
            `;
            tbody.appendChild(tr);
        }
        // Подключаем обработчики
        tbody.querySelectorAll("a[data-action]").forEach(a => {
            a.addEventListener("click", e => {
                e.preventDefault();
                const action = a.getAttribute("data-action");
                const key = a.getAttribute("data-key");
                handleAction(action, key);
            });
        });
    } catch (e) {
        errBox.textContent = `Ошибка загрузки: ${e.message}`;
        errBox.style.display = "";
    }
}

async function handleAction(action, key) {
    if (action === "revoke") {
        const reason = prompt("Причина отзыва (необязательно):", "");
        if (reason === null) return;
        try {
            await adminApi("POST", "/v1/admin/revoke", { license_key: key, reason: reason || null });
            loadList();
        } catch (e) {
            alert("Ошибка: " + e.message);
        }
    } else if (action === "restore") {
        if (!confirm(`Снять отзыв с ключа ${key}?`)) return;
        try {
            await adminApi("POST", "/v1/admin/restore", { license_key: key });
            loadList();
        } catch (e) {
            alert("Ошибка: " + e.message);
        }
    } else if (action === "note") {
        const note = prompt("Примечание (внутреннее):", "");
        if (note === null) return;
        try {
            await adminApi("POST", "/v1/admin/set_note", { license_key: key, note });
            loadList();
        } catch (e) {
            alert("Ошибка: " + e.message);
        }
    }
}

// =====================================================================
// Init
// =====================================================================
document.addEventListener("DOMContentLoaded", () => {
    if (getToken()) {
        loadList().then(showDashboard).catch(() => {
            setToken("");
            showLogin();
        });
    } else {
        showLogin();
    }
    document.getElementById("login-btn").addEventListener("click", doLogin);
    document.getElementById("admin-token").addEventListener("keydown", e => {
        if (e.key === "Enter") doLogin();
    });
    document.getElementById("logout").addEventListener("click", e => {
        e.preventDefault();
        doLogout();
    });
    document.getElementById("issue-form").addEventListener("submit", submitIssue);
    document.getElementById("refresh-btn").addEventListener("click", e => {
        e.preventDefault();
        loadList();
    });
});
