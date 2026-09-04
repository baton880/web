(function () {
    const TOKEN_KEY = "token";
    const ROLE_KEY = "role";
    const USERNAME_KEY = "username";
    const DEFAULT_API_PORT = "3000";

    const LOGIN_PAGE = "login.html";
    const LOGIN_ROUTE = "/login";
    const RESET_PASSWORD_PAGE = "reset-password.html";
    const RESET_PASSWORD_ROUTE = "/reset-password";
    const DIGEST_SETTINGS_PAGE = "digest-settings.html";
    const DIGEST_SETTINGS_ROUTE = "/digest/settings";
    const VIOLATIONS_PAGE = "violations.html";
    const REPORTS_PAGE = "reports.html";
    const ADMIN_TELEMETRY_PAGE = "telemetry-admin.html";
    const BATCH_DETAILS_PAGE = "batch-details.html";

    const ROLE_ADMIN = "ADMIN";
    const ROLE_DIRECTOR = "DIRECTOR";
    const ROLE_GUEST = "GUEST";

    const APP_PAGES = new Set([
        "loader-terminals.html",
        "index.html",
        "tables.html",
        VIOLATIONS_PAGE,
        REPORTS_PAGE,
        "rations.html",
        "groups.html",
        BATCH_DETAILS_PAGE,
        DIGEST_SETTINGS_PAGE,
        "map-zones.html",
        ADMIN_TELEMETRY_PAGE,
    ]);
    const ADMIN_ONLY_PAGES = new Set([ADMIN_TELEMETRY_PAGE]);
    const GUEST_RESTRICTED_PAGES = new Set([DIGEST_SETTINGS_PAGE, "loader-terminals.html"]);

    const WRITE_ROLES = new Set([ROLE_ADMIN, ROLE_DIRECTOR]);

    function normalizeRole(role) {
        return typeof role === "string" ? role.trim().toUpperCase() : "";
    }

    function getToken() {
        const token = localStorage.getItem(TOKEN_KEY);
        return typeof token === "string" ? token.trim() : "";
    }

    function getUsername() {
        const username = localStorage.getItem(USERNAME_KEY);
        return typeof username === "string" ? username.trim() : "";
    }

    function getAuthHeaders(options) {
        const settings = options || {};
        const headers = {
            ...(settings.headers || {}),
        };
        const token = getToken();

        if (settings.includeJson) {
            headers["Content-Type"] = "application/json";
        }

        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        return headers;
    }

    function getApiOrigin() {
        const { protocol, hostname, port, origin } = window.location;

        if (!hostname) {
            return `http://localhost:${DEFAULT_API_PORT}`;
        }

        if (!port || port === DEFAULT_API_PORT) {
            return origin;
        }

        return `${protocol}//${hostname}:${DEFAULT_API_PORT}`;
    }

    function getApiUrl(path) {
        if (typeof path !== "string" || !path.trim()) {
            return getApiOrigin();
        }

        if (/^https?:\/\//i.test(path)) {
            return path;
        }

        const normalizedPath = path.startsWith("/") ? path : `/${path}`;
        return `${getApiOrigin()}${normalizedPath}`;
    }

    function decodeBase64Url(value) {
        const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        return atob(padded);
    }

    function getTokenPayload(token) {
        if (!token) {
            return null;
        }

        try {
            const payloadChunk = token.split(".")[1];
            if (!payloadChunk) {
                return null;
            }

            return JSON.parse(decodeBase64Url(payloadChunk));
        } catch (error) {
            return null;
        }
    }

    function getRoleFromToken(token) {
        const payload = getTokenPayload(token);
        return normalizeRole(payload?.role);
    }

    function isTokenExpired(token) {
        const payload = getTokenPayload(token);
        const expiresAt = Number(payload?.exp);

        if (!Number.isFinite(expiresAt)) {
            return false;
        }

        return (Date.now() >= expiresAt * 1000);
    }

    function getRole() {
        const storedRole = normalizeRole(localStorage.getItem(ROLE_KEY));
        if (storedRole) {
            return storedRole;
        }

        const derivedRole = getRoleFromToken(getToken());
        if (derivedRole) {
            localStorage.setItem(ROLE_KEY, derivedRole);
        }

        return derivedRole;
    }

    function setSession(token, role, username) {
        if (token) {
            localStorage.setItem(TOKEN_KEY, token);
        } else {
            localStorage.removeItem(TOKEN_KEY);
        }

        const normalizedRole = normalizeRole(role) || getRoleFromToken(token);
        if (normalizedRole) {
            localStorage.setItem(ROLE_KEY, normalizedRole);
        } else {
            localStorage.removeItem(ROLE_KEY);
        }

        const normalizedUsername = typeof username === "string" ? username.trim() : "";
        if (token && normalizedUsername) {
            localStorage.setItem(USERNAME_KEY, normalizedUsername);
        } else if (!token) {
            localStorage.removeItem(USERNAME_KEY);
        }
    }

    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(ROLE_KEY);
        localStorage.removeItem(USERNAME_KEY);
    }

    function isAuthenticated() {
        const token = getToken();
        return Boolean(token && !isTokenExpired(token) && getRole());
    }

    function isAdmin() {
        return getRole() === ROLE_ADMIN;
    }

    function isGuest() {
        return getRole() === ROLE_GUEST;
    }

    function hasWriteAccess() {
        return WRITE_ROLES.has(getRole());
    }

    function getCurrentPageName() {
        const path = window.location.pathname.replace(/\\/g, "/");
        const pageName = path.split("/").pop();
        return pageName || "index.html";
    }

    function getNormalizedPathname() {
        const pathname = window.location.pathname.replace(/\\/g, "/");
        if (!pathname || pathname === "/") {
            return "/";
        }

        return pathname.replace(/\/+$/, "") || "/";
    }

    function isLoginPage() {
        return getCurrentPageName() === LOGIN_PAGE || getNormalizedPathname() === LOGIN_ROUTE;
    }

    function isResetPasswordPage() {
        return getCurrentPageName() === RESET_PASSWORD_PAGE || getNormalizedPathname() === RESET_PASSWORD_ROUTE;
    }

    function isDigestSettingsPage() {
        return getCurrentPageName() === DIGEST_SETTINGS_PAGE || getNormalizedPathname() === DIGEST_SETTINGS_ROUTE;
    }

    function buildUrl(pageName, params) {
        const url = new URL(pageName, window.location.href);

        Object.entries(params || {}).forEach(([key, value]) => {
            if (value) {
                url.searchParams.set(key, value);
            }
        });

        return url.toString();
    }

    function redirectToLogin(reason) {
        clearSession();
        window.location.replace(buildUrl(LOGIN_ROUTE, { error: reason || "auth-required" }));
    }

    function redirectToHome(reason) {
        window.location.replace(buildUrl("index.html", { error: reason || "no-access" }));
    }

    function resolveAlertHost() {
        return (
            document.querySelector("[data-page-alerts]") ||
            document.querySelector(".container-fluid") ||
            document.querySelector(".page-wrapper") ||
            document.querySelector(".container") ||
            document.body
        );
    }

    function ensureAlertStyles() {
        if (document.getElementById("appPageAlertStyles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "appPageAlertStyles";
        style.textContent = `
            .app-page-alert {
                opacity: 0;
                transform: translateY(-8px);
                transition: opacity 0.22s ease, transform 0.22s ease;
            }

            .app-page-alert.is-visible {
                opacity: 1;
                transform: translateY(0);
            }
        `;
        document.head.appendChild(style);
    }

    function dismissAlerts() {
        const host = resolveAlertHost();
        if (!host) {
            return;
        }

        host.querySelectorAll("[data-page-alert]").forEach((alert) => {
            alert.remove();
        });
    }

    function showAlert(message, type, options) {
        const host = resolveAlertHost();
        if (!host) {
            return;
        }

        ensureAlertStyles();

        const settings = options || {};
        const existingAlerts = Array.from(host.querySelectorAll("[data-page-alert]"));
        const alert = existingAlerts.shift() || document.createElement("div");
        existingAlerts.forEach((existingAlert) => existingAlert.remove());

        alert.className = `alert alert-${type || "danger"} shadow-sm app-page-alert`;
        alert.dataset.pageAlert = "true";
        alert.innerHTML = "";

        if (settings.actionLabel && typeof settings.onAction === "function") {
            alert.classList.add("d-flex", "justify-content-between", "align-items-center", "flex-wrap");

            const text = document.createElement("div");
            text.className = "mr-3 flex-grow-1";
            text.textContent = message;

            const actionButton = document.createElement("button");
            actionButton.type = "button";
            actionButton.className = settings.actionClassName || "btn btn-sm btn-outline-success bg-white text-success border-success font-weight-bold mt-2 mt-sm-0";
            actionButton.textContent = settings.actionLabel;
            actionButton.addEventListener("click", () => {
                settings.onAction({ alert, button: actionButton, text });
            });

            alert.append(text, actionButton);
        } else {
            alert.textContent = message;
        }

        if (!alert.isConnected) {
            host.prepend(alert);
        }

        alert.classList.remove("is-visible");
        void alert.offsetWidth;
        window.requestAnimationFrame(() => {
            alert.classList.add("is-visible");
        });

        return alert;
    }

    function getRoleLabel(role) {
        const labels = {
            [ROLE_ADMIN]: "Администратор",
            [ROLE_DIRECTOR]: "Директор",
            [ROLE_GUEST]: "Гость",
        };

        return labels[normalizeRole(role)] || "Пользователь";
    }

    function getRoleBadgeClass(role) {
        const normalizedRole = normalizeRole(role);

        if (normalizedRole === ROLE_ADMIN) {
            return "app-auth-account__role-badge--admin";
        }

        if (normalizedRole === ROLE_DIRECTOR) {
            return "app-auth-account__role-badge--director";
        }

        return "app-auth-account__role-badge--guest";
    }

    function ensureAccountPanelStyles() {
        if (document.getElementById("appAuthAccountStyles")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "appAuthAccountStyles";
        style.textContent = `
            .app-auth-account {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .app-auth-account__meta {
                line-height: 1.1;
                text-align: right;
            }
            .app-auth-account__name {
                font-weight: 700;
                color: #3a3b45;
            }
            .app-auth-account__role {
                font-size: 0.8rem;
                color: #858796;
            }
            .app-auth-account__role-badge {
                display: inline-flex;
                align-items: center;
                padding: 4px 9px;
                border-radius: 999px;
                font-size: 0.75rem;
                font-weight: 700;
                letter-spacing: 0.02em;
                margin-top: 4px;
            }
            .app-auth-account__role-badge--admin {
                background: #fde7e9;
                color: #a61d24;
            }
            .app-auth-account__role-badge--director {
                background: #e7f4ea;
                color: #1e7a3b;
            }
            .app-auth-account__role-badge--guest {
                background: #e8efff;
                color: #2e59d9;
            }
            @media (max-width: 576px) {
                .app-auth-account {
                    gap: 8px;
                }
                .app-auth-account__meta {
                    display: none;
                }
            }
        `;
        document.head.appendChild(style);
    }

    async function logout() {
        try {
            await fetch(getApiUrl("/api/auth/logout"), {
                method: "POST",
                credentials: "same-origin",
            });
        } catch (error) {
        } finally {
            clearSession();
            window.location.replace(buildUrl(LOGIN_ROUTE));
        }
    }

    function renderAccountPanel() {
        if (isLoginPage() || isResetPasswordPage() || document.getElementById("appAuthAccountPanel")) {
            return;
        }

        const topbar = document.querySelector(".topbar");
        if (!topbar) {
            return;
        }

        ensureAccountPanelStyles();

        const panel = document.createElement("div");
        panel.id = "appAuthAccountPanel";
        panel.className = "app-auth-account ml-auto";

        const meta = document.createElement("div");
        meta.className = "app-auth-account__meta";

        const name = document.createElement("div");
        name.className = "app-auth-account__name";
        name.textContent = getUsername() || "Неизвестный";

        const role = document.createElement("div");
        role.className = `app-auth-account__role app-auth-account__role-badge ${getRoleBadgeClass(getRole())}`;
        role.textContent = getRoleLabel(getRole());

        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-outline-secondary btn-sm";
        button.textContent = "Выйти";
        button.addEventListener("click", logout);

        meta.append(name, role);
        panel.append(meta, button);
        topbar.append(panel);
    }

    function consumeErrorMessage() {
        const url = new URL(window.location.href);
        const errorCode = url.searchParams.get("error");

        if (!errorCode) {
            return;
        }

        if (isLoginPage() && (errorCode === "auth-required" || errorCode === "session-invalid")) {
            url.searchParams.delete("error");
            window.history.replaceState({}, document.title, url.toString());
            return;
        }

        const messages = {
            "auth-required": { type: "warning", text: "Войдите в систему." },
            "session-invalid": { type: "warning", text: "Сессия недействительна. Войдите снова." },
            "no-access": { type: "danger", text: "Нет доступа." },
        };

        const alertConfig = messages[errorCode];
        if (alertConfig) {
            showAlert(alertConfig.text, alertConfig.type);
        }

        url.searchParams.delete("error");
        window.history.replaceState({}, document.title, url.toString());
    }

    function hideTelemetryNavigation() {
        if (isAdmin()) {
            return;
        }

        document.querySelectorAll('a[href="telemetry-admin.html"]').forEach((link) => {
            const navItem = link.closest(".nav-item");
            if (navItem) {
                navItem.style.display = "none";
            } else {
                link.style.display = "none";
            }
        });
    }

    function hideDigestNavigation() {
        if (!isGuest()) {
            return;
        }

        document.querySelectorAll('a[href="digest-settings.html"], a[href="/digest/settings"], a[href="loader-terminals.html"]').forEach((link) => {
            const navItem = link.closest(".nav-item");
            if (navItem) {
                navItem.style.display = "none";
            } else {
                link.style.display = "none";
            }
        });
    }

    function applyReadOnlyState() {
        const canWrite = hasWriteAccess();
        const admin = isAdmin();
        const role = getRole();

        document.documentElement.setAttribute("data-role", role || "");
        document.documentElement.setAttribute("data-can-write", canWrite ? "true" : "false");

        document.querySelectorAll("[data-requires-admin]").forEach((element) => {
            element.hidden = !admin;
        });

        document.querySelectorAll("[data-requires-write]").forEach((element) => {
            element.hidden = !canWrite;
        });

        document.querySelectorAll("[data-readonly-banner]").forEach((element) => {
            element.classList.toggle("d-none", canWrite);
        });
    }

    function guardCurrentPage() {
        const pageName = getCurrentPageName();
        const isDigestPage = isDigestSettingsPage();

        if (isLoginPage()) {
            if (isAuthenticated()) {
                window.location.replace(buildUrl("index.html"));
                return false;
            }

            return true;
        }

        if (isResetPasswordPage()) {
            return true;
        }

        if (!APP_PAGES.has(pageName) && !isDigestPage) {
            return true;
        }

        const effectivePageName = isDigestPage ? DIGEST_SETTINGS_PAGE : pageName;

        const token = getToken();

        if (!token) {
            redirectToLogin("auth-required");
            return false;
        }

        if (isTokenExpired(token)) {
            redirectToLogin("session-invalid");
            return false;
        }

        if (!getRole()) {
            redirectToLogin("session-invalid");
            return false;
        }

        if (ADMIN_ONLY_PAGES.has(effectivePageName) && !isAdmin()) {
            redirectToHome("no-access");
            return false;
        }

        if (GUEST_RESTRICTED_PAGES.has(effectivePageName) && isGuest()) {
            redirectToHome("no-access");
            return false;
        }

        return true;
    }

    function initPageChrome() {
        consumeErrorMessage();
        hideTelemetryNavigation();
        hideDigestNavigation();
        applyReadOnlyState();
        renderAccountPanel();
    }

    const accessAllowed = guardCurrentPage();

    window.AppAuth = {
        ROLE_ADMIN,
        ROLE_DIRECTOR,
        ROLE_GUEST,
        clearSession,
        getAuthHeaders,
        getApiUrl,
        getRole,
        getToken,
        getUsername,
        hasWriteAccess,
        isAdmin,
        isGuest,
        isAuthenticated,
        dismissAlerts,
        logout,
        setSession,
        showAlert,
    };

    if (!accessAllowed) {
        return;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initPageChrome, { once: true });
    } else {
        initPageChrome();
    }
})();
