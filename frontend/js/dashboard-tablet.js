(function () {
    'use strict';

    const root = document.getElementById('dashboardTabletList');
    if (!root) return;
    const api = path => window.AppAuth?.getApiUrl?.(path) || path;
    const headers = () => window.AppAuth?.getAuthHeaders?.() || {};
    const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
    const time = value => value ? new Date(Number(value)).toLocaleString('ru-RU') : 'Нет данных';
    const element = (tag, className, content) => {
        const node = document.createElement(tag);
        node.className = className;
        if (content != null) node.textContent = content;
        return node;
    };
    const metric = (parent, label, value) => {
        const item = element('div', 'dashboard-tablet-metric');
        item.append(element('span', '', label), element('strong', '', value));
        parent.append(item);
    };
    const request = async path => {
        const response = await fetch(api(path), { headers: headers(), cache: 'no-store' });
        if (!response.ok) throw new Error('Не удалось получить состояние планшета');
        return response.json();
    };

    function render(devices, readings) {
        root.replaceChildren();
        if (!devices.length) {
            root.append(element('div', 'dashboard-tablet-empty', 'Зарегистрированных планшетов пока нет.'));
            return;
        }
        devices.forEach(device => {
            const lastSeen = Number(device.lastSeenAt) || 0;
            const online = lastSeen > 0 && Date.now() - lastSeen < 45000;
            const task = device.task;
            const card = element('article', 'dashboard-tablet');
            const heading = element('div', 'dashboard-tablet-heading');
            const title = element('div', 'dashboard-tablet-title');
            title.append(element('strong', '', device.name || 'Планшет'), element('span', '', device.deviceId || ''));
            heading.append(title, element('span', `dashboard-tablet-state ${online ? 'is-online' : 'is-offline'}`, online ? 'На связи' : 'Нет связи'));
            card.append(heading);

            const details = element('div', 'dashboard-tablet-details');
            metric(details, 'Последняя связь', time(lastSeen));
            if (device.version) metric(details, 'Версия', device.version);
            if (task) {
                metric(details, 'Задание', task.status === 'ready' ? 'Ожидает начала' : 'Идёт загрузка');
                metric(details, 'Группа', task.groupName || '—');
                metric(details, 'Рацион', task.rationName || '—');
            } else {
                metric(details, 'Задание', 'Нет активного замеса');
            }
            card.append(details);

            if (!task?.steps?.length) {
                const summary = element('div', 'dashboard-tablet-progress');
                const line = element('div', 'dashboard-tablet-progress-line');
                line.append(element('strong', '', 'Прогресс замеса'), element('span', '', 'Ожидание'));
                summary.append(line, element('div', 'dashboard-tablet-progress-track'));
                summary.append(element('div', 'dashboard-tablet-progress-meta', 'Шкала появится при загрузке компонента.'));
                card.append(summary);
            } else {
                const index = Math.max(0, Math.min(Number(task.currentIndex) || 0, task.steps.length - 1));
                const step = task.steps[index];
                const target = Number(step.targetKg) || 0;
                const reading = readings.get(device.deviceId);
                const readingAt = Date.parse(reading?.timestamp || '');
                const fresh = online && reading?.weightValid !== false && Number.isFinite(readingAt) && Date.now() - readingAt < 15000;
                const baseline = Number(step.baselineKg);
                const canMeasure = task.status === 'active' && step.baselineKg != null && fresh && Number.isFinite(baseline) && Number.isFinite(Number(reading.weight));
                const current = canMeasure ? Math.max(0, Number(reading.weight) - baseline) : null;
                const percent = target > 0 && current != null ? current / target * 100 : null;
                const summary = element('div', 'dashboard-tablet-progress');
                const line = element('div', 'dashboard-tablet-progress-line');
                line.append(element('strong', '', step.name || 'Компонент'), element('span', '', `Шаг ${index + 1} из ${task.steps.length}`));
                summary.append(line);
                const track = element('div', 'dashboard-tablet-progress-track');
                const fill = element('div', 'dashboard-tablet-progress-fill');
                fill.style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
                track.append(fill);
                track.setAttribute('role', 'progressbar');
                track.setAttribute('aria-label', `Загрузка ${step.name || 'компонента'}`);
                track.setAttribute('aria-valuemin', '0');
                track.setAttribute('aria-valuemax', String(target));
                if (current != null) track.setAttribute('aria-valuenow', String(Math.min(target, Math.round(current))));
                summary.append(track);
                summary.append(element('div', 'dashboard-tablet-progress-meta', current == null
                    ? `План ${number(target)} кг · ${task.status === 'ready' ? 'ожидает начала' : 'нет свежего веса'}`
                    : `${number(current)} / ${number(target)} кг · ${number(percent)}%`));
                card.append(summary);
            }
            root.append(card);
        });
    }

    let polling = false;
    async function refresh() {
        if (polling) return;
        polling = true;
        try {
            const { devices = [] } = await request('/api/loader/dashboard');
            const activeDevices = [...new Set(devices.filter(device => device.task?.status === 'active').map(device => device.deviceId))];
            const results = await Promise.all(activeDevices.map(async deviceId => {
                try { return [deviceId, await request(`/api/loader/weight?deviceId=${encodeURIComponent(deviceId)}`)]; }
                catch { return [deviceId, null]; }
            }));
            render(devices, new Map(results));
        } catch (error) {
            root.replaceChildren(element('div', 'dashboard-tablet-empty', error.message));
        } finally {
            polling = false;
        }
    }

    void refresh();
    window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
}());
