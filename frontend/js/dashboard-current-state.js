(function () {
    const WARNING_API_URL = window.AppAuth?.getApiUrl?.("/api/telemetry/warnings/current") || "/api/telemetry/warnings/current";
    const STOP_BATCH_API_URL = window.AppAuth?.getApiUrl?.("/api/telemetry/host/manual-stop") || "/api/telemetry/host/manual-stop";
    const CAN_VIEW_WARNING_SECTION = window.AppAuth?.isAdmin?.() === true;
    const CAN_STOP_BATCH = window.AppAuth?.isAdmin?.() === true;
    const WARNING_SECTION_TITLE = "Технические предупреждения";
    const WARNING_EMPTY_TEXT = "Активных предупреждений нет.";
    const WARNING_LOADING_TEXT = "Ожидание телеметрии...";

    let latestWarningItems = [];
    let latestWarningSource = "backend";
    let latestWarningUpdatedAt = null;
    let warningApiAvailability = "unknown";
    let stopBatchInFlight = false;
    let stopBatchTarget = null;

    async function readDashboardErrorMessage(response) {
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            try {
                const payload = await response.json();
                return payload?.error || payload?.message || "";
            } catch (error) {
                return "";
            }
        }

        try {
            return (await response.text()).trim();
        } catch (error) {
            return "";
        }
    }

    function normalizeWarningSeverity(value) {
        const normalized = String(value || "").trim().toLowerCase();

        if (
            normalized.includes("danger") ||
            normalized.includes("error") ||
            normalized.includes("critical") ||
            normalized.includes("alarm")
        ) {
            return "danger";
        }

        if (
            normalized.includes("info") ||
            normalized.includes("notice") ||
            normalized.includes("hint")
        ) {
            return "info";
        }

        return "warning";
    }

    function normalizeWarningItem(item, index) {
        if (!item) {
            return null;
        }

        if (typeof item === "string") {
            return {
                code: `warning_${index + 1}`,
                title: item,
                message: "",
                severity: "warning",
            };
        }

        if (item.active === false || item.enabled === false || item.resolved === true) {
            return null;
        }

        const title = String(
            item.title ||
            item.label ||
            item.name ||
            item.message ||
            item.text ||
            item.code ||
            `warning_${index + 1}`
        ).trim();

        const rawMessage = item.message || item.text || item.description || item.details || "";
        const message = String(rawMessage).trim();

        if (!title) {
            return null;
        }

        return {
            code: String(item.code || item.key || item.id || `warning_${index + 1}`),
            title,
            message: message === title ? "" : message,
            severity: normalizeWarningSeverity(item.severity || item.level || item.tone || item.status),
        };
    }

    function normalizeWarningPayload(payload) {
        const rawItems = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.items)
                ? payload.items
                : Array.isArray(payload?.warnings)
                    ? payload.warnings
                    : [];

        return {
            items: rawItems
                .map((item, index) => normalizeWarningItem(item, index))
                .filter(Boolean),
            source: "backend",
            updatedAt: payload?.updatedAt || payload?.timestamp || payload?.generatedAt || null,
        };
    }

    function getFreshPacketsWarningMessage(data) {
        if (latestFetchState.status === "error") {
            return latestFetchState.errorMessage || "Не удалось обновить телеметрию.";
        }

        if (latestFetchState.status === "empty" || isEmptyTelemetry(data)) {
            return "Телеметрия ещё не поступала.";
        }

        const packetTime = formatDateTime(data?.timestamp);
        if (packetTime !== "--") {
            return `Последний пакет устарел. Последнее время: ${packetTime}.`;
        }

        return `Телеметрия не обновлялась дольше ${Math.round(OFFLINE_THRESHOLD_MS / 1000)} сек.`;
    }

    function buildFallbackWarnings(data, rtkData) {
        const items = [];
        const hasLoadedTelemetry = latestFetchState.hasLoadedAtLeastOnce;
        const isInitialLoading = latestFetchState.status === "loading" && !hasLoadedTelemetry;

        if (isInitialLoading) {
            return items;
        }

        const hasFreshHostPacket =
            !isEmptyTelemetry(data) &&
            latestFetchState.status !== "error" &&
            latestFetchState.status !== "empty" &&
            isPacketOnline(data?.timestamp);

        if (!hasFreshHostPacket) {
            items.push({
                code: "no_fresh_packets",
                title: "Нет свежих пакетов",
                message: getFreshPacketsWarningMessage(data),
                severity: latestFetchState.status === "error" ? "danger" : "warning",
            });
            return items;
        }

        const gpsQuality = Number(data?.gpsQuality);
        const hasGpsCoordinates = hasValidCoordinates(data?.lat, data?.lon);
        const hasGpsFlag = data?.gpsValid == null ? true : asBoolean(data.gpsValid);
        const hasGps = hasGpsCoordinates && hasGpsFlag && (!Number.isFinite(gpsQuality) || gpsQuality > 0);

        if (!hasGps) {
            items.push({
                code: "no_gps",
                title: "Нет GPS",
                message: "Координаты не определены или GPS fix отсутствует.",
                severity: "danger",
            });
        }

        const hasFreshRtkPacket = Boolean(rtkData) && isPacketOnline(rtkData?.timestamp);
        if (!hasFreshRtkPacket) {
            items.push({
                code: "no_rtk",
                title: "Нет погрузчика",
                message: "Не удалось получить актуальный пакет погрузчика.",
                severity: "warning",
            });
        }

        const hasConfiguredZones = Array.isArray(storageZones) && storageZones.some((zone) => zone?.active);
        if (hasConfiguredZones && hasGpsCoordinates) {
            const zoneName = getCurrentZoneName(Number(data.lat), Number(data.lon));
            if (!zoneName) {
                items.push({
                    code: "unknown_zone",
                    title: "Неизвестная зона",
                    message: "Текущие координаты не попали ни в одну активную зону.",
                    severity: "warning",
                });
            }
        }

        return items;
    }

    function getRenderedWarningItems(data) {
        if (latestWarningSource === "backend") {
            return Array.isArray(latestWarningItems) ? latestWarningItems : [];
        }

        return buildFallbackWarnings(data, latestRtkTelemetry);
    }

    function getWarningsMetaText(items) {
        if (latestFetchState.status === "loading" && !latestFetchState.hasLoadedAtLeastOnce) {
            return WARNING_LOADING_TEXT;
        }

        const countLabel = items.length > 0 ? `Активно: ${items.length}` : "Система в норме";
        const updatedLabel = latestWarningUpdatedAt ? ` | ${formatDateTime(latestWarningUpdatedAt)}` : "";

        return `${countLabel}${updatedLabel}`;
    }

    function renderWarnings(data) {
        const sectionElement = document.getElementById("dashboardWarningsSection");
        const titleElement = document.getElementById("dashboardWarningsHeading");
        const metaElement = document.getElementById("dashboardWarningsMeta");
        const listElement = document.getElementById("dashboardWarningsList");

        if (!CAN_VIEW_WARNING_SECTION) {
            if (sectionElement) {
                sectionElement.hidden = true;
            }
            return;
        }

        if (!titleElement || !metaElement || !listElement) {
            return;
        }

        const items = getRenderedWarningItems(data);

        titleElement.textContent = WARNING_SECTION_TITLE;
        metaElement.textContent = getWarningsMetaText(items);

        if (!items.length) {
            listElement.innerHTML = `<div class="dashboard-warning-empty">${escapeHtml(WARNING_EMPTY_TEXT)}</div>`;
            return;
        }

        listElement.innerHTML = items.map((item) => {
            const severity = normalizeWarningSeverity(item?.severity);
            const title = escapeHtml(item?.title || "Предупреждение");
            const message = item?.message
                ? `<div class="dashboard-warning-item__message">${escapeHtml(item.message)}</div>`
                : "";

            return `
                <article class="dashboard-warning-item dashboard-warning-item--${severity}" data-warning-code="${escapeHtml(item?.code || "")}">
                    <div class="dashboard-warning-item__icon" aria-hidden="true">
                        <i class="fas fa-exclamation-triangle"></i>
                    </div>
                    <div class="dashboard-warning-item__content">
                        <div class="dashboard-warning-item__title">${title}</div>
                        ${message}
                    </div>
                </article>
            `;
        }).join("");
    }

    async function syncWarningsFromResponse(response, data, rtkData) {
        if (!CAN_VIEW_WARNING_SECTION) {
            latestWarningItems = [];
            latestWarningSource = "backend";
            latestWarningUpdatedAt = null;
            return;
        }

        if (!response || !response.ok) {
            latestWarningItems = [];
            latestWarningSource = "backend";
            latestWarningUpdatedAt = null;
            return;
        }

        try {
            const payload = await response.json();
            const normalized = normalizeWarningPayload(payload);
            latestWarningItems = normalized.items;
            latestWarningSource = normalized.source;
            latestWarningUpdatedAt = normalized.updatedAt || data?.timestamp || rtkData?.timestamp || null;
        } catch (error) {
            latestWarningItems = [];
            latestWarningSource = "backend";
            latestWarningUpdatedAt = null;
        }
    }

    function getStopBatchButton() {
        return document.getElementById("dashboardStopBatchButton");
    }

    function updateStopBatchButton(batch) {
        const button = getStopBatchButton();
        if (!button) {
            return;
        }

        if (!CAN_STOP_BATCH) {
            button.classList.add("d-none");
            button.disabled = true;
            return;
        }

        const batchId = Number.parseInt(batch?.id, 10);
        const hasActiveBatch = Number.isInteger(batchId) && batchId > 0;

        if (!hasActiveBatch) {
            button.classList.add("d-none");
            button.disabled = true;
            button.textContent = "Остановить замес";
            stopBatchTarget = null;
            return;
        }

        stopBatchTarget = {
            id: batchId,
            deviceId: typeof latestTelemetry?.deviceId === "string" && latestTelemetry.deviceId.trim()
                ? latestTelemetry.deviceId.trim()
                : null,
        };

        button.classList.remove("d-none");
        button.disabled = stopBatchInFlight;
        button.textContent = stopBatchInFlight ? "Останавливаем..." : "Остановить замес";
    }

    async function stopActiveBatch() {
        if (stopBatchInFlight || !CAN_STOP_BATCH || !stopBatchTarget?.id) {
            return;
        }

        const approved = window.confirm(`Остановить замес #${stopBatchTarget.id}?`);
        if (!approved) {
            return;
        }

        stopBatchInFlight = true;
        updateStopBatchButton(stopBatchTarget);

        try {
            const response = await fetch(STOP_BATCH_API_URL, {
                method: "POST",
                headers: getHeaders(),
                body: JSON.stringify({
                    batchId: stopBatchTarget.id,
                    deviceId: stopBatchTarget.deviceId,
                }),
            });

            if (!response.ok) {
                const errorMessage = await readDashboardErrorMessage(response);
                throw new Error(errorMessage || `HTTP ${response.status}`);
            }

            window.AppAuth?.showAlert?.(`Замес #${stopBatchTarget.id} остановлен`, "success");
            await fetchLatest();
            if (typeof fetchHistory === "function") {
                await fetchHistory();
            }
        } catch (error) {
            window.AppAuth?.showAlert?.(error?.message || "Не удалось остановить замес", "danger");
        } finally {
            stopBatchInFlight = false;
            updateStopBatchButton(latestTelemetry?.active_batch);
        }
    }

    async function fetchWarningsResponse() {
        if (!CAN_VIEW_WARNING_SECTION || warningApiAvailability === "unavailable") {
            return null;
        }

        const response = await fetch(WARNING_API_URL, {
            headers: getHeaders(),
            cache: "no-store",
        }).catch(() => null);

        if (response?.ok) {
            warningApiAvailability = "available";
            return response;
        }

        if (response?.status === 404) {
            warningApiAvailability = "unavailable";
        }

        return response;
    }

    renderUnloadProgress = function (mode, unloadProgress) {
        const isVisible = getModeLabel(mode) === "Выгрузка";
        const bar = document.getElementById("dashboardUnloadProgressBar");
        const targetValue = parseNumber(unloadProgress?.target_weight);
        const factValue = parseNumber(unloadProgress?.unloaded_fact);
        const hasProgressData = targetValue !== null || factValue !== null;

        setSectionVisible("dashboardUnloadProgressCard", Boolean(isVisible));

        if (!bar) {
            return;
        }

        if (!isVisible) {
            bar.style.width = "0%";
            bar.classList.remove("is-over");
            setText("dashboardUnloadProgressMeta", "--");
            return;
        }

        if (!hasProgressData) {
            bar.style.width = "0%";
            bar.classList.remove("is-over");
            setText("dashboardUnloadProgressMeta", "--");
            return;
        }

        const target = Math.max(targetValue ?? 0, 0);
        const fact = Math.max(factValue ?? 0, 0);
        const progress = target > 0 ? (fact / target) * 100 : 0;
        const fillPercent = Math.max(Math.min(progress, 100), 0);

        bar.style.width = `${fillPercent}%`;
        bar.classList.toggle("is-over", progress > 100);
        setText(
            "dashboardUnloadProgressMeta",
            `${formatMetric(fact, 1)} / ${formatMetric(target, 1)} кг (${progress.toFixed(0)}%)`
        );
    };

    renderActiveBatch = function (batch) {
        const tbody = document.getElementById("dashboardActiveBatchTableBody");
        if (!tbody) {
            return;
        }

        const batchId = Number.parseInt(batch?.id, 10);
        const hasActiveBatch = Number.isInteger(batchId) && batchId > 0;
        const rows = Array.isArray(batch?.ingredients) ? batch.ingredients : [];
        const isVisible = hasActiveBatch;

        setSectionVisible("dashboardActiveBatchCard", isVisible);
        updateStopBatchButton(hasActiveBatch ? batch : null);

        if (!isVisible) {
            setText("dashboardActiveBatchMeta", "--");
            tbody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">--</td></tr>';
            return;
        }

        const metaParts = [];
        metaParts.push(`Замес #${batchId}`);
        metaParts.push(`Компонентов: ${rows.length}`);

        setText("dashboardActiveBatchMeta", metaParts.join(" | "));

        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="dashboard-mini-table-empty">Компоненты ещё не зафиксированы</td></tr>';
            return;
        }

        tbody.innerHTML = rows.map((row) => {
            const name = escapeHtml(row?.name ?? "--");
            const plan = formatMetric(row?.plan, 1);
            const fact = formatMetric(row?.fact, 1);
            const deviation = formatSignedPercent(row?.deviation_percent, 1);
            const isViolation = asBoolean(row?.is_violation);

            return `
                <tr>
                    <td>${name}</td>
                    <td>${plan}</td>
                    <td>${fact}</td>
                    <td>${deviation}</td>
                    <td>
                        <span class="dashboard-bool-badge ${isViolation ? "is-yes" : "is-no"}">
                            ${isViolation ? "Да" : "Нет"}
                        </span>
                    </td>
                </tr>
            `;
        }).join("");
    };

    renderDashboard = function (data) {
        updateCurrentStateNotice(data);
        renderWarnings(data);

        if (isEmptyTelemetry(data)) {
            resetTelemetryActivity();
            setVehicleStatus(false);
            setText("dashboardCurrentZone", "--");
            renderModeBadge(data?.mode);
            setText("dashboardCurrentWeight", "--");
            setText(
                "dashboardLastPacketTime",
                latestFetchState.status === "loading" && !latestFetchState.hasLoadedAtLeastOnce
                    ? "Загрузка..."
                    : "--"
            );
            renderUnloadProgress(data?.mode, data?.unload_progress);
            renderActiveBatch(data?.active_batch);
            hidePlacemark();
            hasLiveCoordinates = false;
            syncMapActionButtons();
            return;
        }

        const isOnline = isTelemetryOnline(data);
        const hasCoordinates = hasValidCoordinates(data.lat, data.lon);
        const parsedLat = Number(data.lat);
        const parsedLon = Number(data.lon);
        const zoneName = hasCoordinates
            ? (getCurrentZoneName(parsedLat, parsedLon) || data?.banner?.zoneName || "Вне зоны")
            : "--";

        setVehicleStatus(isOnline);
        setText("dashboardCurrentZone", zoneName);
        renderModeBadge(data?.mode);
        setText("dashboardCurrentWeight", data.weight != null ? `${formatMetric(data.weight, 1)} кг` : "--");
        setText("dashboardLastPacketTime", formatDateTime(data.timestamp));
        renderUnloadProgress(data?.mode, data?.unload_progress);
        renderActiveBatch(data?.active_batch);

        updateMapPosition(data, isOnline);
    };

    fetchLatest = async function () {
        try {
            const [hostResponse, rtkResponse, warningsResponse] = await Promise.all([
                fetch(getLatestApiUrl(), { headers: getHeaders() }),
                fetch(getRtkLatestApiUrl(), { headers: getHeaders() }).catch(() => null),
                fetchWarningsResponse(),
            ]);

            if (!hostResponse.ok) {
                const errorMessage = await readDashboardErrorMessage(hostResponse);
                latestFetchState.status = !isEmptyTelemetry(latestTelemetry) ? "stale" : "error";
                latestFetchState.errorMessage = errorMessage || "Не удалось обновить текущее состояние.";
                latestWarningSource = "backend";
                latestWarningItems = [];
                latestWarningUpdatedAt = null;
                renderDashboard(latestTelemetry);
                return;
            }

            latestTelemetry = await hostResponse.json();
            latestFetchState.hasLoadedAtLeastOnce = true;
            latestFetchState.status = isEmptyTelemetry(latestTelemetry) ? "empty" : "ready";
            latestFetchState.errorMessage = "";

            noteTelemetryActivity(latestTelemetry);

            if (rtkResponse && rtkResponse.ok) {
                latestRtkTelemetry = await rtkResponse.json();
            } else if (rtkResponse && rtkResponse.status === 404) {
                latestRtkTelemetry = null;
                hideRtkPlacemark();
            }

            syncTelemetryZoneBanners();
            await syncWarningsFromResponse(warningsResponse, latestTelemetry, latestRtkTelemetry);

            renderDashboard(latestTelemetry);
            updateRtkMapPosition(latestRtkTelemetry);
        } catch (error) {
            console.error("Error fetching latest:", error);
            latestFetchState.status = !isEmptyTelemetry(latestTelemetry) ? "stale" : "error";
            latestFetchState.errorMessage = "Не удалось обновить текущее состояние.";
            latestWarningSource = "backend";
            latestWarningItems = [];
            latestWarningUpdatedAt = null;
            renderDashboard(latestTelemetry);
        }
    };

    const stopBatchButton = getStopBatchButton();
    if (stopBatchButton && !stopBatchButton.dataset.bound) {
        stopBatchButton.dataset.bound = "1";
        stopBatchButton.addEventListener("click", stopActiveBatch);
    }

    renderDashboard(latestTelemetry);
})();
