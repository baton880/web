import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../tmp/weight-filter-lab.html')
const CONTEXT_MS = 3 * 60 * 1000

function toIso(value) {
  return value ? new Date(value).toISOString() : null
}

function round1(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

async function loadPayload() {
  const batches = await prisma.batch.findMany({
    include: {
      group: true,
      ration: true,
      actualIngredients: {
        orderBy: [
          { startedAt: 'asc' },
          { addedAt: 'asc' },
          { id: 'asc' }
        ]
      }
    },
    orderBy: [
      { startTime: 'asc' },
      { id: 'asc' }
    ]
  })

  const items = []
  for (const batch of batches) {
    const startMs = new Date(batch.startTime).getTime()
    const endMs = new Date(batch.endTime || batch.startTime).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue

    const telemetry = await prisma.telemetry.findMany({
      where: {
        deviceId: batch.deviceId,
        timestamp: {
          gte: new Date(startMs - CONTEXT_MS),
          lte: new Date(endMs + CONTEXT_MS)
        }
      },
      select: {
        id: true,
        timestamp: true,
        weight: true,
        rawWeight: true,
        speedKmh: true
      },
      orderBy: [
        { timestamp: 'asc' },
        { id: 'asc' }
      ]
    })

    items.push({
      id: batch.id,
      deviceId: batch.deviceId,
      startTime: toIso(batch.startTime),
      endTime: toIso(batch.endTime),
      groupName: batch.group?.name || '',
      rationName: batch.ration?.name || '',
      startWeight: round1(batch.startWeight),
      endWeight: round1(batch.endWeight),
      oldIngredientSum: round1(batch.actualIngredients.reduce((sum, item) => sum + Number(item.actualWeight || 0), 0)),
      ingredients: batch.actualIngredients.map((item) => ({
        id: item.id,
        name: item.ingredientName,
        actualWeight: round1(item.actualWeight),
        startedAt: toIso(item.startedAt || item.addedAt),
        addedAt: toIso(item.addedAt)
      })),
      telemetry: telemetry.map((row) => ({
        t: toIso(row.timestamp),
        w: round1(row.weight),
        r: round1(row.rawWeight),
        s: round1(row.speedKmh)
      }))
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Novosibirsk',
    batches: items
  }
}

function buildHtml(payload) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Weight filter lab</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #667085;
      --line: #d8dee9;
      --accent: #1f6feb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      padding: 14px 18px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 18px;
      line-height: 1.25;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(240px, 1.5fr) repeat(5, minmax(120px, 1fr));
      gap: 10px;
      align-items: end;
    }
    label {
      display: grid;
      gap: 4px;
      font-size: 12px;
      color: var(--muted);
    }
    select, input[type="number"] {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 8px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 8px 10px;
      cursor: pointer;
    }
    main { padding: 14px 18px 24px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: center;
    }
    .toggles label {
      display: inline-flex;
      grid-template-columns: none;
      gap: 6px;
      align-items: center;
      color: var(--ink);
      font-size: 13px;
      white-space: nowrap;
    }
    .swatch {
      width: 20px;
      height: 3px;
      border-radius: 99px;
      display: inline-block;
    }
    #info {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    #chart {
      width: 100%;
      height: 620px;
      display: block;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 8px;
      cursor: crosshair;
    }
    #tooltip {
      position: fixed;
      pointer-events: none;
      display: none;
      background: rgba(23, 32, 51, 0.94);
      color: #fff;
      padding: 8px 9px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.35;
      z-index: 5;
      max-width: 300px;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      margin-top: 8px;
    }
    @media (max-width: 1050px) {
      .controls { grid-template-columns: 1fr 1fr; }
      #chart { height: 520px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Weight filter lab</h1>
    <div class="controls">
      <label>Замес
        <select id="batchSelect"></select>
      </label>
      <label>Rolling median radius
        <input id="medianRadius" type="number" min="0" max="25" step="1" value="3">
      </label>
      <label>Hampel radius
        <input id="hampelRadius" type="number" min="1" max="35" step="1" value="5">
      </label>
      <label>Hampel sigma
        <input id="hampelSigma" type="number" min="0.5" max="8" step="0.1" value="3">
      </label>
      <label>Average radius
        <input id="avgRadius" type="number" min="0" max="25" step="1" value="2">
      </label>
      <button id="resetBtn" type="button">Сброс</button>
    </div>
  </header>

  <main>
    <section class="panel">
      <div class="toggles" id="toggles"></div>
      <div class="hint">Клик/движение по графику покажет значения рядом с точкой. Вертикальные линии: пунктир = startedAt, сплошная = addedAt.</div>
    </section>
    <section class="panel" id="info"></section>
    <canvas id="chart"></canvas>
  </main>
  <div id="tooltip"></div>

  <script>
    window.WEIGHT_FILTER_LAB_DATA = ${escapeScriptJson(payload)};
  </script>
  <script>
    const DATA = window.WEIGHT_FILTER_LAB_DATA;
    const COLORS = {
      weight: '#334155',
      raw: '#ef4444',
      median: '#2563eb',
      hampel: '#f59e0b',
      hampelMedian: '#16a34a',
      hampelMedianAverage: '#9333ea',
      speed: '#64748b'
    };
    const LINE_DEFS = [
      ['weight', 'Telemetry.weight'],
      ['raw', 'Telemetry.rawWeight'],
      ['median', 'rawWeight rolling median'],
      ['hampel', 'rawWeight Hampel'],
      ['hampelMedian', 'rawWeight Hampel + rolling median'],
      ['hampelMedianAverage', 'rawWeight Hampel + rolling median + light average']
    ];
    const state = {
      hoverX: null,
      showSpeed: true,
      showIngredients: true,
      round5: false,
      lines: new Set(['weight', 'raw', 'median', 'hampelMedianAverage'])
    };

    const batchSelect = document.getElementById('batchSelect');
    const toggles = document.getElementById('toggles');
    const info = document.getElementById('info');
    const canvas = document.getElementById('chart');
    const tooltip = document.getElementById('tooltip');
    const ctx = canvas.getContext('2d');

    function ts(value) {
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : null;
    }

    function localTime(value) {
      return new Date(value).toLocaleTimeString('ru-RU', { timeZone: DATA.timezone });
    }

    function localDateTime(value) {
      return new Date(value).toLocaleString('ru-RU', { timeZone: DATA.timezone });
    }

    function finite(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function median(values) {
      const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
      if (!sorted.length) return null;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function rollingMedian(values, radius) {
      if (radius <= 0) return values.slice();
      return values.map((value, index) => {
        const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1));
        return median(slice) ?? value;
      });
    }

    function rollingAverage(values, radius) {
      if (radius <= 0) return values.slice();
      return values.map((value, index) => {
        const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1)).filter(Number.isFinite);
        return slice.length ? slice.reduce((sum, item) => sum + item, 0) / slice.length : value;
      });
    }

    function hampel(values, radius, sigma) {
      return values.map((value, index) => {
        if (!Number.isFinite(value)) return value;
        const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1)).filter(Number.isFinite);
        const med = median(slice);
        if (!Number.isFinite(med)) return value;
        const mad = median(slice.map((item) => Math.abs(item - med)));
        const threshold = sigma * 1.4826 * (mad || 1);
        return Math.abs(value - med) > threshold ? med : value;
      });
    }

    function maybeRound5(values) {
      if (!state.round5) return values;
      return values.map((value) => Number.isFinite(value) ? Math.round(value / 5) * 5 : value);
    }

    function buildSeries(batch) {
      const medianRadius = Number(document.getElementById('medianRadius').value) || 0;
      const hampelRadius = Number(document.getElementById('hampelRadius').value) || 1;
      const hampelSigma = Number(document.getElementById('hampelSigma').value) || 3;
      const avgRadius = Number(document.getElementById('avgRadius').value) || 0;

      const points = batch.telemetry.map((row) => ({
        x: ts(row.t),
        weight: finite(row.w),
        raw: finite(row.r),
        speed: finite(row.s)
      })).filter((point) => Number.isFinite(point.x));
      const raw = points.map((point) => Number.isFinite(point.raw) ? point.raw : point.weight);
      const med = rollingMedian(raw, medianRadius);
      const h = hampel(raw, hampelRadius, hampelSigma);
      const hm = rollingMedian(h, medianRadius);
      const hma = rollingAverage(hm, avgRadius);

      return {
        points,
        lines: {
          weight: points.map((point) => point.weight),
          raw,
          median: maybeRound5(med),
          hampel: maybeRound5(h),
          hampelMedian: maybeRound5(hm),
          hampelMedianAverage: maybeRound5(hma)
        },
        speed: points.map((point) => point.speed)
      };
    }

    function selectedBatch() {
      return DATA.batches.find((batch) => String(batch.id) === batchSelect.value) || DATA.batches[0];
    }

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(600, Math.floor(rect.width * dpr));
      canvas.height = Math.max(420, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      const batch = selectedBatch();
      if (!batch) return;
      resizeCanvas();
      const built = buildSeries(batch);
      const points = built.points;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const margin = { left: 58, right: 18, top: 22, bottom: state.showSpeed ? 108 : 48 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;
      const speedTop = height - 78;
      const speedH = 42;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);

      const xs = points.map((point) => point.x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const activeValues = [];
      for (const key of state.lines) {
        for (const value of built.lines[key] || []) {
          if (Number.isFinite(value)) activeValues.push(value);
        }
      }
      const minYRaw = Math.min(...activeValues);
      const maxYRaw = Math.max(...activeValues);
      const padY = Math.max(50, (maxYRaw - minYRaw) * 0.08);
      const minY = Math.floor((minYRaw - padY) / 50) * 50;
      const maxY = Math.ceil((maxYRaw + padY) / 50) * 50;
      const xScale = (x) => margin.left + ((x - minX) / Math.max(1, maxX - minX)) * plotW;
      const yScale = (y) => margin.top + (1 - ((y - minY) / Math.max(1, maxY - minY))) * plotH;

      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Arial';
      for (let i = 0; i <= 6; i += 1) {
        const y = minY + ((maxY - minY) / 6) * i;
        const py = yScale(y);
        ctx.beginPath();
        ctx.moveTo(margin.left, py);
        ctx.lineTo(width - margin.right, py);
        ctx.stroke();
        ctx.fillText(String(Math.round(y)), 8, py + 4);
      }

      for (let i = 0; i <= 8; i += 1) {
        const x = minX + ((maxX - minX) / 8) * i;
        const px = xScale(x);
        ctx.beginPath();
        ctx.moveTo(px, margin.top);
        ctx.lineTo(px, margin.top + plotH);
        ctx.stroke();
        ctx.fillText(localTime(x), px - 24, margin.top + plotH + 20);
      }

      const batchStartX = xScale(ts(batch.startTime));
      const batchEndX = xScale(ts(batch.endTime || batch.startTime));
      ctx.fillStyle = 'rgba(31,111,235,0.06)';
      ctx.fillRect(batchStartX, margin.top, Math.max(1, batchEndX - batchStartX), plotH);
      ctx.strokeStyle = 'rgba(31,111,235,0.45)';
      ctx.setLineDash([5, 5]);
      for (const x of [batchStartX, batchEndX]) {
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotH);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (state.showIngredients) {
        const names = [...new Set(batch.ingredients.map((item) => item.name))];
        const palette = ['#dc2626', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be123c'];
        for (const ingredient of batch.ingredients) {
          const color = palette[Math.max(0, names.indexOf(ingredient.name)) % palette.length];
          const sx = xScale(ts(ingredient.startedAt));
          const ex = xScale(ts(ingredient.addedAt));
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 5]);
          ctx.beginPath();
          ctx.moveTo(sx, margin.top);
          ctx.lineTo(sx, margin.top + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(ex, margin.top);
          ctx.lineTo(ex, margin.top + plotH);
          ctx.stroke();
          ctx.save();
          ctx.translate(ex + 3, margin.top + 12 + (names.indexOf(ingredient.name) % 8) * 14);
          ctx.rotate(-Math.PI / 10);
          ctx.fillStyle = color;
          ctx.font = '11px Arial';
          ctx.fillText(\`\${ingredient.name} \${Math.round(ingredient.actualWeight || 0)}\`, 0, 0);
          ctx.restore();
        }
      }

      for (const [key] of LINE_DEFS) {
        if (!state.lines.has(key)) continue;
        const values = built.lines[key];
        ctx.strokeStyle = COLORS[key];
        ctx.lineWidth = key === 'hampelMedianAverage' ? 2.2 : 1.35;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < points.length; i += 1) {
          const value = values[i];
          if (!Number.isFinite(value)) {
            started = false;
            continue;
          }
          const px = xScale(points[i].x);
          const py = yScale(value);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }

      if (state.showSpeed) {
        ctx.strokeStyle = '#e5e7eb';
        ctx.strokeRect(margin.left, speedTop, plotW, speedH);
        const speeds = built.speed.filter(Number.isFinite);
        const maxS = Math.max(5, Math.ceil(Math.max(...speeds, 0)));
        const ySpeed = (speed) => speedTop + speedH - (Math.max(0, speed) / maxS) * speedH;
        ctx.strokeStyle = COLORS.speed;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < points.length; i += 1) {
          const speed = built.speed[i];
          if (!Number.isFinite(speed)) {
            started = false;
            continue;
          }
          const px = xScale(points[i].x);
          const py = ySpeed(speed);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText(\`speed 0..\${maxS} km/h\`, margin.left + 4, speedTop - 6);
      }

      if (state.hoverX !== null) {
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(state.hoverX, margin.top);
        ctx.lineTo(state.hoverX, margin.top + plotH);
        ctx.stroke();
      }

      renderInfo(batch, built);
      canvas._chartMeta = { minX, maxX, xScale, margin, plotH, built };
    }

    function renderInfo(batch, built) {
      const hma = built.lines.hampelMedianAverage.filter(Number.isFinite);
      const raw = built.lines.raw.filter(Number.isFinite);
      const hmaGain = hma.length ? Math.max(...hma) - Math.min(...hma) : 0;
      const rawGain = raw.length ? Math.max(...raw) - Math.min(...raw) : 0;
      info.innerHTML = \`
        <b>#\${batch.id}</b> \${localDateTime(batch.startTime)} - \${batch.endTime ? localDateTime(batch.endTime) : '-'}
        · \${batch.groupName || '-'} / \${batch.rationName || '-'}<br>
        oldIngredientSum: <b>\${Math.round(batch.oldIngredientSum || 0)} кг</b>
        · raw range: <b>\${Math.round(rawGain)} кг</b>
        · selected filtered range: <b>\${Math.round(hmaGain)} кг</b>
        · points: \${batch.telemetry.length}
        · generated: \${localDateTime(DATA.generatedAt)}
      \`;
    }

    function renderToggles() {
      toggles.innerHTML = '';
      for (const [key, label] of LINE_DEFS) {
        const item = document.createElement('label');
        item.innerHTML = \`<input type="checkbox" data-line="\${key}" \${state.lines.has(key) ? 'checked' : ''}>
          <span class="swatch" style="background:\${COLORS[key]}"></span>\${label}\`;
        toggles.appendChild(item);
      }
      for (const extra of [
        ['showIngredients', 'вертикальные линии ингредиентов'],
        ['showSpeed', 'скорость снизу'],
        ['round5', 'округлять фильтры до 5 кг']
      ]) {
        const item = document.createElement('label');
        item.innerHTML = \`<input type="checkbox" data-extra="\${extra[0]}" \${state[extra[0]] ? 'checked' : ''}> \${extra[1]}\`;
        toggles.appendChild(item);
      }
    }

    function init() {
      for (const batch of DATA.batches) {
        const option = document.createElement('option');
        option.value = batch.id;
        option.textContent = \`#\${batch.id} \${localDateTime(batch.startTime)} \${batch.groupName || ''} \${batch.rationName || ''}\`;
        batchSelect.appendChild(option);
      }
      const preferred = DATA.batches.find((batch) => batch.id === 46) || DATA.batches[0];
      if (preferred) batchSelect.value = preferred.id;
      renderToggles();
      draw();
    }

    document.addEventListener('input', (event) => {
      const line = event.target?.dataset?.line;
      const extra = event.target?.dataset?.extra;
      if (line) {
        if (event.target.checked) state.lines.add(line);
        else state.lines.delete(line);
      }
      if (extra) state[extra] = event.target.checked;
      draw();
    });
    batchSelect.addEventListener('change', draw);
    window.addEventListener('resize', draw);
    document.getElementById('resetBtn').addEventListener('click', () => {
      document.getElementById('medianRadius').value = 3;
      document.getElementById('hampelRadius').value = 5;
      document.getElementById('hampelSigma').value = 3;
      document.getElementById('avgRadius').value = 2;
      state.lines = new Set(['weight', 'raw', 'median', 'hampelMedianAverage']);
      state.showSpeed = true;
      state.showIngredients = true;
      state.round5 = false;
      renderToggles();
      draw();
    });

    canvas.addEventListener('mousemove', (event) => {
      const meta = canvas._chartMeta;
      if (!meta) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      state.hoverX = x;
      const ratio = (x - meta.margin.left) / Math.max(1, canvas.clientWidth - meta.margin.left - 18);
      const target = meta.minX + Math.max(0, Math.min(1, ratio)) * (meta.maxX - meta.minX);
      const points = meta.built.points;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i += 1) {
        const d = Math.abs(points[i].x - target);
        if (d < bestDistance) {
          bestDistance = d;
          bestIndex = i;
        }
      }
      const rows = [\`<b>\${localTime(points[bestIndex].x)}</b>\`];
      for (const [key, label] of LINE_DEFS) {
        if (!state.lines.has(key)) continue;
        const value = meta.built.lines[key][bestIndex];
        rows.push(\`<span style="color:\${COLORS[key]}">\${label}: \${Number.isFinite(value) ? Math.round(value) : '-'}</span>\`);
      }
      const speed = meta.built.speed[bestIndex];
      if (Number.isFinite(speed)) rows.push(\`speed: \${speed} km/h\`);
      tooltip.innerHTML = rows.join('<br>');
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(window.innerWidth - 320, event.clientX + 14) + 'px';
      tooltip.style.top = Math.min(window.innerHeight - 180, event.clientY + 14) + 'px';
      draw();
    });
    canvas.addEventListener('mouseleave', () => {
      state.hoverX = null;
      tooltip.style.display = 'none';
      draw();
    });

    init();
  </script>
</body>
</html>`
}

const payload = await loadPayload()
await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
await fs.writeFile(OUTPUT_PATH, buildHtml(payload), 'utf8')
console.log(OUTPUT_PATH)
await prisma.$disconnect()
