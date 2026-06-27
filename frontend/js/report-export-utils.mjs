function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.replace(",", "."));
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function parseDate(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDateKey(value) {
    const parsed = parseDate(value);
    if (!parsed) {
        return "";
    }

    return [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, "0"),
        String(parsed.getDate()).padStart(2, "0"),
    ].join("-");
}

function roundWeight(value) {
    return Math.round((toNumber(value) ?? 0) * 10) / 10;
}

export function buildDailyDeviationRows(components = []) {
    const totals = new Map();

    for (const item of Array.isArray(components) ? components : []) {
        const dateKey = getDateKey(item.date);
        const componentName = String(item.component || "").trim();
        if (!dateKey || !componentName || componentName === "\u2014") {
            continue;
        }

        const rationName = item.rationName || "\u0411\u0435\u0437 \u0440\u0430\u0446\u0438\u043e\u043d\u0430";
        const groupName = item.groupName || "\u0411\u0435\u0437 \u0433\u0440\u0443\u043f\u043f\u044b";
        const key = [dateKey, rationName, groupName, componentName].join("\u0000");
        const current = totals.get(key) || {
            date: dateKey,
            rationName,
            groupName,
            component: componentName,
            plan: 0,
            fact: 0,
        };

        current.plan += toNumber(item.plan) ?? 0;
        current.fact += toNumber(item.fact) ?? 0;
        totals.set(key, current);
    }

    const rows = [
        [
            "\u0414\u0430\u0442\u0430",
            "\u0420\u0430\u0446\u0438\u043e\u043d",
            "\u0413\u0440\u0443\u043f\u043f\u0430",
            "\u041a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442",
            "\u041f\u043b\u0430\u043d \u0437\u0430 \u0441\u0443\u0442\u043a\u0438",
            "\u0424\u0430\u043a\u0442 \u0437\u0430 \u0441\u0443\u0442\u043a\u0438",
            "\u041e\u0442\u043a\u043b\u043e\u043d\u0435\u043d\u0438\u0435 \u0437\u0430 \u0441\u0443\u0442\u043a\u0438",
        ],
    ];

    Array.from(totals.values())
        .sort((left, right) => (
            left.date.localeCompare(right.date)
            || left.rationName.localeCompare(right.rationName, "ru")
            || left.groupName.localeCompare(right.groupName, "ru")
            || left.component.localeCompare(right.component, "ru")
        ))
        .forEach((item) => {
            rows.push([
                item.date,
                item.rationName,
                item.groupName,
                item.component,
                roundWeight(item.plan),
                roundWeight(item.fact),
                roundWeight(item.fact - item.plan),
            ]);
        });

    return rows;
}
