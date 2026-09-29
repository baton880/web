(function (root) {
    // Drawing-only min/max buckets. Calculations, table values and replay keep all rows.
    function sample(rows, valueAt, budget = 1200) {
        if (rows.length <= budget) return rows;
        const selected = new Set([0, rows.length - 1]);
        const buckets = Math.max(1, Math.floor((budget - 2) / 4));
        for (let bucket = 0; bucket < buckets; bucket += 1) {
            const start = Math.floor(bucket * rows.length / buckets);
            const end = Math.floor((bucket + 1) * rows.length / buckets);
            let min = -1, max = -1, gap = -1;
            for (let i = start; i < end; i += 1) {
                const value = valueAt(rows[i]);
                if (!Number.isFinite(value)) { gap = i; continue; }
                if (min < 0 || value < valueAt(rows[min])) min = i;
                if (max < 0 || value > valueAt(rows[max])) max = i;
            }
            selected.add(start);
            if (min >= 0) selected.add(min);
            if (max >= 0) selected.add(max);
            if (gap >= 0) selected.add(gap);
        }
        return [...selected].sort((a, b) => a - b).map(index => rows[index]);
    }
    root.BatchChartSampling = { sample };
    if (typeof module !== 'undefined') module.exports = { sample };
})(typeof window === 'undefined' ? globalThis : window);
