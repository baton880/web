const POLL_INTERVAL_MS = 5000;
const HISTORY_LIMIT = 20;
const OFFLINE_THRESHOLD_MS = 15000;
const TELEMETRY_SETTINGS_NUMERIC_FIELDS = [
    "batchStartThresholdKg",
    "leftoverThresholdKg",
    "unloadDropThresholdKg",
    "unloadMinPeakKg",
    "unloadUpdateDeltaKg",
    "unloadWeightBufferKg",
    "emptyVehicleThresholdKg",
    "autoCloseZeroWeightKg",
    "autoCloseEmptyStreak",
    "autoCloseNegativeStreak",
    "modeUnloadDropHintKg",
    "modeLoadingDeltaHintKg",
    "anomalyThresholdKg",
    "anomalyConfirmDeltaKg",
    "anomalyConfirmPackets",
    "zoneChangeDebounceMs",
    "nullZoneConfirmSeconds",
    "zoneChangeConfirmPackets",
    "deviationPercentThreshold",
    "deviationMinKgThreshold",
];

const endpoints = {
    host: {
        latest: window.AppAuth?.getApiUrl?.("/api/telemetry/host/admin/latest") || "/api/telemetry/host/admin/latest",
        history: window.AppAuth?.getApiUrl?.(`/api/telemetry/host/admin/history?limit=${HISTORY_LIMIT}`) || `/api/telemetry/host/admin/history?limit=${HISTORY_LIMIT}`,
        truncate: window.AppAuth?.getApiUrl?.("/api/telemetry/host/admin/truncate") || "/api/telemetry/host/admin/truncate",
    },
    events: {
        history: window.AppAuth?.getApiUrl?.("/api/events?limit=500") || "/api/events?limit=500",
        truncate: window.AppAuth?.getApiUrl?.("/api/events/admin/truncate") || "/api/events/admin/truncate",
    },
    rtk: {
        latest: window.AppAuth?.getApiUrl?.("/api/telemetry/rtk/admin/latest") || "/api/telemetry/rtk/admin/latest",
        history: window.AppAuth?.getApiUrl?.(`/api/telemetry/rtk/admin/history?limit=${HISTORY_LIMIT}`) || `/api/telemetry/rtk/admin/history?limit=${HISTORY_LIMIT}`,
        truncate: window.AppAuth?.getApiUrl?.("/api/telemetry/rtk/admin/truncate") || "/api/telemetry/rtk/admin/truncate",
    },
    settings: {
        current: window.AppAuth?.getApiUrl?.("/api/telemetry/settings") || "/api/telemetry/settings",
    },
};

const CAN_ADMIN_RESET = window.AppAuth?.isAdmin?.() === true;

function getHeaders() {
    return window.AppAuth?.getAuthHeaders?.() || {};
}

function formatDateTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("ru-RU");
}

function hasTelemetryTimestamp(value) {
    if (!value) return false;

    const timestamp = new Date(value).getTime();
    return !Number.isNaN(timestamp);
}

function isPacketOnline(timestamp) {
    if (!hasTelemetryTimestamp(timestamp)) return false;

    return (Date.now() - new Date(timestamp).getTime()) < OFFLINE_THRESHOLD_MS;
}

function getTelemetryState(latest, source = "host") {
    if (!hasTelemetryTimestamp(latest?.timestamp)) {
        return {
            label: "Нет данных",
            panelLabel: "Нет данных",
            mode: "warn",
            online: false,
        };
    }

    if (isPacketOnline(latest.timestamp)) {
        return {
            label: "Онлайн",
            panelLabel: "Поток активен",
            mode: "ok",
            online: true,
        };
    }

    return {
        label: "Оффлайн",
        panelLabel: "Нет свежих пакетов",
        mode: "offline",
        online: false,
    };
}

function formatNumber(value, digits = 5) {
    if (value === null || value === undefined || value === "") return "--";
    const number = Number(value);
    return Number.isNaN(number) ? "--" : number.toFixed(digits);
}

function formatShortNumber(value, digits = 1) {
    if (value === null || value === undefined || value === "") return "--";
    const number = Number(value);
    return Number.isNaN(number) ? "--" : number.toFixed(digits);
}

function formatBytes(value) {
    if (value === null || value === undefined || value === "") return "--";

    const number = Number(value);
    if (Number.isNaN(number)) return "--";

    if (Math.abs(number) < 1024) {
        return `${number} B`;
    }

    const units = ["KB", "MB", "GB"];
    let size = number / 1024;
    let unitIndex = 0;

    while (Math.abs(size) >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    return `${formatShortNumber(size, size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function boolBadge(value) {
    const enabled = value === true || value === 1 || value === "true";
    return `<span class="telemetry-badge ${enabled ? "ok" : "warn"}">${enabled ? "Да" : "Нет"}</span>`;
}

function qualityBadge(label, quality) {
    const normalizedLabel = String(label || "").trim().toLowerCase();
    const numericQuality = Number(quality);
    const isFixed = normalizedLabel.includes("fixed") || numericQuality >= 4;
    const isFloat = normalizedLabel.includes("float") || numericQuality === 2 || numericQuality === 3;
    const badgeMode = isFixed ? "ok" : (isFloat ? "warn" : "offline");
    const text = label || (quality != null ? `Q${quality}` : "--");
    return `<span class="telemetry-badge ${badgeMode}">${text}</span>`;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function setStatus(id, label, mode) {
    const element = document.getElementById(id);
    if (element) {
        element.innerHTML = `<span class="telemetry-badge ${mode}">${label}</span>`;
    }
}

function formatWifiClients(value) {
    if (!value) return "--";
    if (Array.isArray(value)) return `${value.length} шт`;
    if (typeof value === "string" && value.startsWith("[")) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.join(", ") || "[]" : value;
        } catch (error) {
            return value;
        }
    }
    if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 40)}...` : value;
    return "--";
}

function formatExtra(row) {
    const parts = [];
    if (row.rawGga) parts.push(`gga:${String(row.rawGga).slice(0, 28)}...`);
    if (row.eventsReaderOk != null) parts.push(`events:${row.eventsReaderOk ? "ok" : "fail"}`);
    if (parts.length === 0) return "--";
    return parts.join(", ");
}

async function readErrorMessage(response) {
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

function setClearButtonsVisibility() {
    ["hostClearButton", "rtkClearButton", "eventsClearButton"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) {
            button.hidden = !CAN_ADMIN_RESET;
        }
    });
}

async function clearAdminData(options) {
    const settings = options || {};
    const button = document.getElementById(settings.buttonId);
    const endpoint = settings.endpoint;
    const confirmMessage = settings.confirmMessage || "Очистить данные?";
    const successMessage = settings.successMessage || "Данные очищены";
    const refreshFn = typeof settings.refreshFn === "function" ? settings.refreshFn : null;

    if (!CAN_ADMIN_RESET || !button || !endpoint) {
        return;
    }

    const confirmed = window.confirm(confirmMessage);
    if (!confirmed) {
        return;
    }

    button.disabled = true;
    const previousHtml = button.innerHTML;
    button.innerHTML = '<span class="spinner-border spinner-border-sm mr-2" role="status" aria-hidden="true"></span>Очищаем...';

    try {
        const response = await fetch(endpoint, {
            method: "DELETE",
            headers: getHeaders(),
            credentials: "same-origin",
        });

        if (!response.ok) {
            const message = await readErrorMessage(response);
            throw new Error(message || "Не удалось очистить данные");
        }

        window.AppAuth?.showAlert?.(successMessage, "success");
        if (refreshFn) {
            await refreshFn();
        }
    } catch (error) {
        window.AppAuth?.showAlert?.(error.message || "Не удалось очистить данные", "danger");
    } finally {
        button.disabled = false;
        button.innerHTML = previousHtml;
    }
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: getHeaders() });

    if (response.status === 404) {
        return { missing: true };
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
}

function setTelemetrySettingsMeta(message) {
    setText("telemetrySettingsMeta", message);
}

function getTelemetrySettingsForm() {
    return document.getElementById("telemetrySettingsForm");
}

function getTelemetrySettingsButton() {
    return document.getElementById("telemetrySettingsSubmitButton");
}

function setTelemetrySettingsButtonState(isSaving) {
    const button = getTelemetrySettingsButton();
    if (!button) return;

    button.disabled = Boolean(isSaving);
    button.innerHTML = isSaving
        ? '<span class="spinner-border spinner-border-sm mr-2" role="status" aria-hidden="true"></span>Сохранение...'
        : 'Сохранить настройки';
}

function fillTelemetrySettingsForm(settings) {
    const form = getTelemetrySettingsForm();
    if (!form || !settings) return;

    TELEMETRY_SETTINGS_NUMERIC_FIELDS.forEach((field) => {
        const input = form.elements.namedItem(field);
        if (input) {
            input.value = settings[field] != null ? String(settings[field]) : "";
        }
    });

    const resetTimeInput = form.elements.namedItem("rtkTrackResetTime");
    if (resetTimeInput) {
        resetTimeInput.value = settings.rtkTrackResetTime || "03:00";
    }
}

async function loadTelemetrySettings() {
    const form = getTelemetrySettingsForm();
    if (!form) return;

    try {
        setTelemetrySettingsMeta("Загрузка настроек...");
        const settings = await fetchJson(endpoints.settings.current);
        fillTelemetrySettingsForm(settings);

        const updatedAt = settings?.updatedAt ? formatDateTime(settings.updatedAt) : "--";
        setTelemetrySettingsMeta(`Последнее изменение: ${updatedAt}`);
        setText("telemetrySettingsState", "Настройки влияют на замес, нарушения, антишум и ежедневную очистку треков.");
    } catch (error) {
        setTelemetrySettingsMeta("Не удалось загрузить настройки");
        setText("telemetrySettingsState", "Сервер не отдал настройки телеметрии.");
        window.AppAuth?.showAlert?.("Не удалось загрузить настройки телеметрии", "danger");
    }
}

async function saveTelemetrySettings(event) {
    event.preventDefault();

    const form = getTelemetrySettingsForm();
    if (!form) return;

    const formData = new FormData(form);
    const payload = {};

    for (const field of TELEMETRY_SETTINGS_NUMERIC_FIELDS) {
        const rawValue = String(formData.get(field) || "").trim();
        const number = Number(rawValue);

        if (!rawValue || !Number.isInteger(number) || number <= 0) {
            window.AppAuth?.showAlert?.("Все пороги должны быть положительными целыми числами", "warning");
            return;
        }

        payload[field] = number;
    }

    const resetTime = String(formData.get("rtkTrackResetTime") || "").trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(resetTime)) {
        window.AppAuth?.showAlert?.("Время очистки треков должно быть в формате HH:mm", "warning");
        return;
    }

    payload.rtkTrackResetTime = resetTime;

    try {
        setTelemetrySettingsButtonState(true);
        const response = await fetch(endpoints.settings.current, {
            method: "PUT",
            headers: {
                ...(getHeaders()),
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const message = await readErrorMessage(response);
            throw new Error(message || "Не удалось сохранить настройки телеметрии");
        }

        const result = await response.json();
        const settings = result?.settings || payload;
        fillTelemetrySettingsForm(settings);
        const updatedAt = settings?.updatedAt ? formatDateTime(settings.updatedAt) : formatDateTime(new Date().toISOString());
        setTelemetrySettingsMeta(`Последнее изменение: ${updatedAt}`);
        setText("telemetrySettingsState", "Настройки сохранены: антишум, пороги нарушений и расписание очистки треков применены.");
        window.AppAuth?.showAlert?.("Настройки телеметрии сохранены", "success");
    } catch (error) {
        setText("telemetrySettingsState", "Не удалось сохранить настройки телеметрии.");
        window.AppAuth?.showAlert?.(error.message || "Не удалось сохранить настройки телеметрии", "danger");
    } finally {
        setTelemetrySettingsButtonState(false);
    }
}

function renderHostSummary(latest) {
    const hostState = getTelemetryState(latest, "host");

    setText("hostStatus", hostState.label);
    setText("hostDevice", latest?.deviceId || "--");
    setText("hostTemperature", latest?.cpuTempC != null ? `${formatShortNumber(latest.cpuTempC, 1)} °C` : "--");
    setText("hostWeight", latest?.weight != null ? `${formatShortNumber(latest.weight, 1)} кг` : "--");
    setText("hostSatellites", latest?.gpsSatellites != null ? String(latest.gpsSatellites) : "--");
    setText("hostCoordinates", latest ? `${formatNumber(latest.lat)}, ${formatNumber(latest.lon)}` : "--");
}

function renderHostTable(rows) {
    const tbody = document.getElementById("hostTelemetryTable");
    if (!tbody) return;

    if (!Array.isArray(rows) || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="14" class="telemetry-empty-state">По хозяину пока нет записей.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${row.id ?? "--"}</td>
            <td>${formatDateTime(row.timestamp)}</td>
            <td>${formatNumber(row.lat)}</td>
            <td>${formatNumber(row.lon)}</td>
            <td>${boolBadge(row.gpsValid)}</td>
            <td>${row.gpsSatellites ?? "--"}</td>
            <td>${row.weight != null ? formatShortNumber(row.weight, 1) : "--"}</td>
            <td>${boolBadge(row.weightValid)}</td>
            <td>${row.gpsQuality ?? "--"}</td>
            <td>${formatWifiClients(row.wifiClients)}</td>
            <td>${row.cpuTempC != null ? formatShortNumber(row.cpuTempC, 1) : "--"}</td>
            <td>${row.lteRssiDbm ?? "--"}</td>
            <td>${row.lteAccessTech || "--"}</td>
            <td>${boolBadge(row.eventsReaderOk)}</td>
        </tr>
    `).join("");
}

function renderLatestSms(event) {
    setText("latestSmsTimestamp", formatDateTime(event?.timestamp));
    setText("latestSmsFrom", event?.fromNumber || "--");
    setText("latestSmsType", event?.type || "--");
    setText("latestSmsText", event?.text || "--");
}

function renderEventsTable(events) {
    const tbody = document.getElementById("eventsTable");
    if (!tbody) return;

    if (!Array.isArray(events) || events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="telemetry-empty-state">За последний месяц событий нет.</td></tr>';
        return;
    }

    tbody.innerHTML = events.map((event) => `
        <tr>
            <td>${event.id ?? "--"}</td>
            <td>${event.type || "--"}</td>
            <td>${formatDateTime(event.timestamp)}</td>
            <td>${event.fromNumber || "--"}</td>
            <td class="telemetry-extra">${event.text || "--"}</td>
            <td>${formatDateTime(event.createdAt)}</td>
        </tr>
    `).join("");
}

async function loadEvents() {
    try {
        const events = await fetchJson(endpoints.events.history);
        const rows = Array.isArray(events) ? events : [];
        const monthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const monthEvents = rows.filter((event) => {
            const timestamp = new Date(event.timestamp).getTime();
            return !Number.isNaN(timestamp) && timestamp >= monthAgo;
        });
        const latestSms = monthEvents.find((event) => event.type === "sms") || null;

        renderLatestSms(latestSms);
        renderEventsTable(monthEvents);
        setStatus("eventsPanelStatus", monthEvents.length ? "События загружены" : "Событий нет", monthEvents.length ? "ok" : "warn");
    } catch (error) {
        renderLatestSms(null);
        renderEventsTable([]);
        setStatus("eventsPanelStatus", "Нет доступа к событиям", "offline");
    }
}

function renderRtkSummary(latest, missing) {
    const rtkState = getTelemetryState(latest, "rtk");
    const qualityValue = latest?.quality != null ? String(latest.quality) : "--";
    const qualityFlagValue = latest?.qualityFlag || latest?.qualityLabel || latest?.rtkQuality || "--";
    const corrAgeValue = latest?.corrAgeS ?? latest?.rtkAge;

    setText("rtkStatus", missing ? "Данные недоступны" : rtkState.label);
    setText("rtkDevice", latest?.deviceId || "--");
    setText("rtkLastPacket", formatDateTime(latest?.timestamp));
    setText("rtkQuality", qualityValue);
    setText("rtkQualityFlag", qualityFlagValue);
    setText("rtkAge", corrAgeValue != null ? `${formatShortNumber(corrAgeValue, 1)} c` : "--");
    setText("rtkValid", latest?.valid == null ? "--" : (latest.valid ? "Да" : "Нет"));
    setText("rtkCoordinates", latest ? `${formatNumber(latest.lat)}, ${formatNumber(latest.lon)}` : "--");
    setText("rtkZone", latest?.zone?.name || "--");
    setText("rtkSatellites", latest?.satellites != null ? String(latest.satellites) : "--");
    setText("rtkHacc", latest?.hacc != null ? `${formatShortNumber(latest.hacc, 3)} м` : "--");
    setText("rtkVacc", latest?.vacc != null ? `${formatShortNumber(latest.vacc, 3)} м` : "--");
    setText("rtkWifiProfile", latest?.wifiProfile || "--");
    setText("rtkRssi", latest?.rssiDbm != null ? `${latest.rssiDbm} dBm` : "--");
    setText("rtkQueue", latest?.ramQueueLen != null ? String(latest.ramQueueLen) : "--");
}

function renderRtkTable(rows, missing) {
    const tbody = document.getElementById("rtkTelemetryTable");
    if (!tbody) return;

    if (missing) {
        tbody.innerHTML = '<tr><td colspan="15" class="telemetry-empty-state">Данные погрузчика недоступны.</td></tr>';
        return;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="15" class="telemetry-empty-state">По погрузчику пока нет записей.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${formatDateTime(row.timestamp)}</td>
            <td>${row.deviceId || "--"}</td>
            <td>${formatNumber(row.lat)}</td>
            <td>${formatNumber(row.lon)}</td>
            <td>${boolBadge(row.valid)}</td>
            <td>${row.quality != null ? row.quality : "--"}</td>
            <td>${qualityBadge(row.qualityFlag || row.qualityLabel || row.rtkQuality, row.quality)}</td>
            <td>${row.satellites != null ? row.satellites : "--"}</td>
            <td>${row.hacc != null ? `${formatShortNumber(row.hacc, 3)} м` : "--"}</td>
            <td>${row.vacc != null ? `${formatShortNumber(row.vacc, 3)} м` : "--"}</td>
            <td>${row.corrAgeS != null ? `${formatShortNumber(row.corrAgeS, 1)} c` : "--"}</td>
            <td>${row.wifiProfile || "--"}</td>
            <td>${row.rssiDbm != null ? `${row.rssiDbm} dBm` : "--"}</td>
            <td>${row.ramQueueLen != null ? row.ramQueueLen : "--"}</td>
            <td>${row.zone?.name || "--"}</td>
        </tr>
    `).join("");
}

async function loadHost() {
    try {
        const [latest, history] = await Promise.all([
            fetchJson(endpoints.host.latest),
            fetchJson(endpoints.host.history),
        ]);

        const hostLatest = latest.missing ? null : latest;
        const hostState = getTelemetryState(hostLatest, "host");

        renderHostSummary(hostLatest);
        renderHostTable(Array.isArray(history) ? history : []);
        setStatus("hostPanelStatus", hostState.panelLabel, hostState.mode);
    } catch (error) {
        renderHostSummary(null);
        renderHostTable([]);
        setStatus("hostPanelStatus", "Ошибка загрузки", "offline");
    }
}

async function loadRtk() {
    if (!endpoints.rtk) {
        renderRtkSummary(null, true);
        renderRtkTable([], true);
        setStatus("rtkPanelStatus", "Данные недоступны", "warn");
        return;
    }

    try {
        const [latest, history] = await Promise.all([
            fetchJson(endpoints.rtk.latest),
            fetchJson(endpoints.rtk.history),
        ]);

        const missing = Boolean(latest.missing || history.missing);
        const rtkLatest = missing ? null : latest;
        const rtkState = getTelemetryState(rtkLatest, "rtk");

        renderRtkSummary(rtkLatest, missing);
        renderRtkTable(Array.isArray(history) ? history : [], missing);
        setStatus("rtkPanelStatus", missing ? "Данные недоступны" : rtkState.panelLabel, missing ? "warn" : rtkState.mode);
    } catch (error) {
        renderRtkSummary(null, true);
        renderRtkTable([], true);
        setStatus("rtkPanelStatus", "Нет связи", "offline");
    }
}

function bindTabs() {
    const buttons = document.querySelectorAll("[data-source]");
    const panels = document.querySelectorAll("[data-panel]");

    buttons.forEach((button) => {
        button.addEventListener("click", () => {
            const currentSource = button.dataset.source;
            buttons.forEach((item) => item.classList.toggle("active", item === button));
            panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === currentSource));
        });
    });
}

function updateSyncTime() {
    setText("telemetryLastSync", `Последняя синхронизация: ${new Date().toLocaleTimeString("ru-RU")}`);
}

async function refreshTelemetry() {
    await Promise.all([loadHost(), loadRtk(), loadEvents()]);
    updateSyncTime();
}

bindTabs();
setClearButtonsVisibility();

document.getElementById("hostClearButton")?.addEventListener("click", function () {
    clearAdminData({
        buttonId: "hostClearButton",
        endpoint: endpoints.host.truncate,
        confirmMessage: "Очистить историю потока «Хозяин»?",
        successMessage: "История «Хозяина» очищена",
        refreshFn: loadHost,
    });
});

document.getElementById("rtkClearButton")?.addEventListener("click", function () {
    clearAdminData({
        buttonId: "rtkClearButton",
        endpoint: endpoints.rtk.truncate,
        confirmMessage: "Очистить историю потока «Погрузчик»?",
        successMessage: "История «Погрузчика» очищена",
        refreshFn: loadRtk,
    });
});

document.getElementById("eventsClearButton")?.addEventListener("click", function () {
    clearAdminData({
        buttonId: "eventsClearButton",
        endpoint: endpoints.events.truncate,
        confirmMessage: "Очистить SMS и входящие звонки?",
        successMessage: "Журнал событий очищен",
        refreshFn: loadEvents,
    });
});

refreshTelemetry();
setInterval(refreshTelemetry, POLL_INTERVAL_MS);

const telemetrySettingsForm = getTelemetrySettingsForm();
if (telemetrySettingsForm) {
    telemetrySettingsForm.addEventListener("submit", saveTelemetrySettings);
    loadTelemetrySettings();
}
