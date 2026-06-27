(function () {
    const DESKTOP_MIN_WIDTH = 769;
    const STORAGE_KEY = "app-sidebar-collapsed";
    const DIGEST_ITEM_ID = "sidebar-digest-settings";
    const DIGEST_PAGE = "digest-settings.html";
    const DIGEST_ROUTE = "/digest/settings";
    const VIOLATIONS_ITEM_ID = "sidebar-violations";
    const VIOLATIONS_PAGE = "violations.html";
    const VIOLATIONS_ROUTE = "/violations";
    const REPORTS_ITEM_ID = "sidebar-reports";
    const REPORTS_PAGE = "reports.html";
    const REPORTS_ROUTE = "/reports";
    const ADMIN_PAGE = "telemetry-admin.html";
    const ADMIN_ROUTE = "/telemetry-admin";
    const body = document.body;
    const sidebar = document.getElementById("accordionSidebar");
    const content = document.getElementById("content");
    let mobileNav = null;
    let mobileMenuToggle = null;
    let mobileMenuList = null;

    if (!body || !sidebar) {
        return;
    }

    function isDesktopViewport() {
        return window.innerWidth >= DESKTOP_MIN_WIDTH;
    }

    function closeMobileMenu() {
        if (!mobileMenuToggle || !mobileMenuList) {
            return;
        }

        mobileMenuToggle.setAttribute("aria-expanded", "false");
        mobileMenuList.hidden = true;
        mobileNav?.classList.remove("is-open");
    }

    function toggleMobileMenu() {
        if (!mobileMenuToggle || !mobileMenuList) {
            return;
        }

        const isOpen = mobileMenuToggle.getAttribute("aria-expanded") === "true";
        mobileMenuToggle.setAttribute("aria-expanded", String(!isOpen));
        mobileMenuList.hidden = isOpen;
        mobileNav?.classList.toggle("is-open", !isOpen);
    }

    function readSavedState() {
        try {
            return window.localStorage.getItem(STORAGE_KEY) === "true";
        } catch (error) {
            return false;
        }
    }

    function saveState(isCollapsed) {
        try {
            window.localStorage.setItem(STORAGE_KEY, String(isCollapsed));
        } catch (error) {
        }
    }

    function getCurrentState() {
        return sidebar.classList.contains("toggled");
    }

    function applyState(isCollapsed) {
        body.classList.toggle("sidebar-toggled", isCollapsed);
        sidebar.classList.toggle("toggled", isCollapsed);
        syncToggleButtons(isCollapsed);
    }

    function syncToggleButtons(isCollapsed) {
        const label = isCollapsed ? "Развернуть меню" : "Свернуть меню";
        document.querySelectorAll("#sidebarToggle, #sidebarToggleTop").forEach((button) => {
            button.setAttribute("aria-label", label);
            button.setAttribute("title", label);
            button.setAttribute("aria-expanded", String(!isCollapsed));
        });
    }

    function syncNavLabels() {
        sidebar.querySelectorAll(".nav-link").forEach((link) => {
            const label = (link.querySelector("span")?.textContent || link.textContent || "").trim();
            if (!label) {
                return;
            }

            link.dataset.navLabel = label;
            if (!link.getAttribute("aria-label")) {
                link.setAttribute("aria-label", label);
            }
        });
    }

    function syncActiveNavigationState() {
        const currentPage = getCurrentPageName();
        const currentPath = getNormalizedPathname();

        sidebar.querySelectorAll(".nav-item .nav-link[href]").forEach((link) => {
            const item = link.closest(".nav-item");
            const href = link.getAttribute("href") || "";
            const hrefPage = href.split("?")[0].split("#")[0].split("/").pop();
            const hrefRoute = `/${(hrefPage || "").replace(/\.html$/i, "")}`;
            const isActive = hrefPage === currentPage || hrefRoute === currentPath || item?.classList.contains("active");

            item?.classList.toggle("active", Boolean(isActive));
            link.classList.toggle("active", Boolean(isActive));

            if (isActive) {
                link.setAttribute("aria-current", "page");
            } else {
                link.removeAttribute("aria-current");
            }
        });
    }

    function createMobileNavLink(sourceLink) {
        const sourceItem = sourceLink.closest(".nav-item");
        const label = sourceLink.dataset.navLabel || (sourceLink.querySelector("span")?.textContent || sourceLink.textContent || "").trim();
        const icon = sourceLink.querySelector("i");
        const mobileLink = document.createElement("a");
        const isActive = sourceItem?.classList.contains("active") || sourceLink.classList.contains("active");

        mobileLink.className = `mobile-menu-link${isActive ? " active" : ""}`;
        mobileLink.href = sourceLink.getAttribute("href") || "#";
        mobileLink.setAttribute("aria-label", label);

        if (isActive) {
            mobileLink.setAttribute("aria-current", "page");
        }

        if (icon) {
            const mobileIcon = document.createElement("i");
            mobileIcon.className = icon.className;
            mobileIcon.setAttribute("aria-hidden", "true");
            mobileLink.appendChild(mobileIcon);
        }

        const text = document.createElement("span");
        text.textContent = label;
        mobileLink.appendChild(text);

        mobileLink.addEventListener("click", closeMobileMenu);

        return mobileLink;
    }

    function syncMobileNavigationItems() {
        if (!mobileMenuList) {
            return;
        }

        mobileMenuList.innerHTML = "";

        sidebar.querySelectorAll(".nav-item .nav-link[href]").forEach((link) => {
            mobileMenuList.appendChild(createMobileNavLink(link));
        });
    }

    function ensureMobileNavigation() {
        if (!content || document.querySelector(".mobile-top-nav")) {
            return;
        }

        mobileNav = document.createElement("nav");
        mobileNav.className = "mobile-top-nav";
        mobileNav.setAttribute("aria-label", "Мобильная навигация");
        mobileNav.innerHTML = `
            <div class="mobile-top-nav__bar">
                <a class="mobile-top-nav__brand" href="index.html" aria-label="ВИ-КОРМ">
                    <img src="img/cow.svg" alt="">
                    <span>ВИ-КОРМ</span>
                </a>
                <button class="mobile-menu-toggle" type="button" aria-controls="mobileMenuList" aria-expanded="false">
                    <i class="fas fa-bars" aria-hidden="true"></i>
                    <span>Меню</span>
                </button>
            </div>
            <div class="mobile-menu-list" id="mobileMenuList" hidden></div>
        `;

        content.insertBefore(mobileNav, content.firstElementChild);

        mobileMenuToggle = mobileNav.querySelector(".mobile-menu-toggle");
        mobileMenuList = mobileNav.querySelector(".mobile-menu-list");
        mobileMenuToggle?.addEventListener("click", toggleMobileMenu);
        syncMobileNavigationItems();
    }

    function getNormalizedPathname() {
        const pathname = window.location.pathname.replace(/\\/g, "/");

        if (!pathname || pathname === "/") {
            return "/";
        }

        return pathname.replace(/\/+$/, "") || "/";
    }

    function getCurrentPageName() {
        const path = window.location.pathname.replace(/\\/g, "/");
        const pageName = path.split("/").pop();
        return pageName || "index.html";
    }

    function ensureNavigationItem(config) {
        const {
            id,
            page,
            route,
            label,
            icon,
            insertAfterHref,
        } = config;

        if (sidebar.querySelector(`[data-sidebar-item="${id}"]`)) {
            return;
        }

        const divider = sidebar.querySelector(".sidebar-divider.d-none.d-md-block");
        const insertAfterLink = insertAfterHref ? sidebar.querySelector(`a[href="${insertAfterHref}"]`) : null;
        const insertAfterItem = insertAfterLink ? insertAfterLink.closest(".nav-item") : null;

        if (!divider && !insertAfterItem) {
            return;
        }

        const navItem = document.createElement("li");
        const isActive = getCurrentPageName() === page || getNormalizedPathname() === route;

        navItem.className = `nav-item${isActive ? " active" : ""}`;
        navItem.dataset.sidebarItem = id;
        navItem.innerHTML = `
            <a class="nav-link" href="${page}"${isActive ? ' aria-current="page"' : ""}>
                <i class="fas fa-fw ${icon}"></i>
                <span>${label}</span>
            </a>
        `;

        if (insertAfterItem) {
            insertAfterItem.insertAdjacentElement("afterend", navItem);
            return;
        }

        sidebar.insertBefore(navItem, divider);
    }

    function ensureViolationsNavigationItem() {
        ensureNavigationItem({
            id: VIOLATIONS_ITEM_ID,
            page: VIOLATIONS_PAGE,
            route: VIOLATIONS_ROUTE,
            label: "Нарушения",
            icon: "fa-exclamation-triangle",
            insertAfterHref: "tables.html",
        });
    }

    function ensureDigestNavigationItem() {
        if (window.AppAuth?.isGuest?.()) {
            return;
        }

        ensureNavigationItem({
            id: DIGEST_ITEM_ID,
            page: DIGEST_PAGE,
            route: DIGEST_ROUTE,
            label: "Уведомления",
            icon: "fa-envelope-open-text",
        });
    }

    function ensureReportsNavigationItem() {
        ensureNavigationItem({
            id: REPORTS_ITEM_ID,
            page: REPORTS_PAGE,
            route: REPORTS_ROUTE,
            label: "Отчеты",
            icon: "fa-chart-bar",
            insertAfterHref: VIOLATIONS_PAGE,
        });
    }

    function syncAdminNavigationItem() {
        const adminLink = sidebar.querySelector(`a[href="${ADMIN_PAGE}"]`);
        const divider = sidebar.querySelector(".sidebar-divider.d-none.d-md-block");
        const adminItem = adminLink ? adminLink.closest(".nav-item") : null;

        if (!adminLink || !adminItem || !divider) {
            return;
        }

        const isActive = getCurrentPageName() === ADMIN_PAGE || getNormalizedPathname() === ADMIN_ROUTE;
        const label = "Админ панель";
        const labelElement = adminLink.querySelector("span");

        if (labelElement) {
            labelElement.textContent = label;
        }

        adminLink.setAttribute("aria-label", label);
        adminLink.classList.toggle("active", isActive);
        adminItem.classList.toggle("active", isActive);
        sidebar.insertBefore(adminItem, divider);
    }

    function syncFromCurrentMarkup() {
        syncToggleButtons(getCurrentState());
    }

    function handleToggleClick() {
        window.setTimeout(() => {
            if (!isDesktopViewport()) {
                syncFromCurrentMarkup();
                return;
            }

            const isCollapsed = getCurrentState();
            saveState(isCollapsed);
            syncToggleButtons(isCollapsed);
        }, 0);
    }

    function handleResize() {
        if (!isDesktopViewport()) {
            body.classList.remove("sidebar-toggled");
            sidebar.classList.remove("toggled");
            syncToggleButtons(false);
            return;
        }

        closeMobileMenu();
        applyState(readSavedState());
    }

    ensureViolationsNavigationItem();
    ensureReportsNavigationItem();
    ensureDigestNavigationItem();
    syncAdminNavigationItem();
    syncNavLabels();
    syncActiveNavigationState();
    ensureMobileNavigation();

    if (isDesktopViewport()) {
        applyState(readSavedState());
    } else {
        syncFromCurrentMarkup();
    }

    document.querySelectorAll("#sidebarToggle, #sidebarToggleTop").forEach((button) => {
        button.addEventListener("click", handleToggleClick);
    });

    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeMobileMenu();
        }
    });
})();
