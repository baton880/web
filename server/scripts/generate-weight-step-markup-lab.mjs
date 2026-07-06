import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../tmp/weight-step-markup-lab.html')
const CONTEXT_MS = 10 * 60 * 1000
const FIRST_BATCH_ID = 29
const LAST_BATCH_ID = 46

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
    where: {
      id: {
        gte: FIRST_BATCH_ID,
        lte: LAST_BATCH_ID
      }
    },
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
        speedKmh: true,
        lat: true,
        lon: true
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
        s: round1(row.speedKmh),
        lat: round1(row.lat),
        lon: round1(row.lon)
      }))
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Novosibirsk',
    batchIdRange: [FIRST_BATCH_ID, LAST_BATCH_ID],
    filter: {
      source: 'rawWeight',
      hampelRadius: 10,
      hampelSigma: 1,
      rollingMedianRadius: 8,
      roundToKg: 5
    },
    batches: items
  }
}

function buildHtml(payload) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Weight step markup lab</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #637083;
      --line: #d7dee8;
      --soft-line: #e7ebf1;
      --load: #168a4a;
      --unload: #dc2626;
      --artifact: #7c8797;
      --filtered: #136f63;
      --raw: #94a3b8;
      --plateau: #2563eb;
      --speed: #64748b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 3;
      padding: 12px 16px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 18px;
      line-height: 1.2;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(260px, 1.4fr) repeat(6, minmax(92px, 1fr));
      gap: 8px;
      align-items: end;
    }
    label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    select, input[type="number"] {
      width: 100%;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 5px 7px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }
    button {
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 9px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }
    main { padding: 12px 16px 24px; }
    .panel {
      margin-bottom: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 10px;
    }
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 16px;
      align-items: center;
    }
    .toggles label {
      display: inline-flex;
      grid-template-columns: none;
      align-items: center;
      gap: 6px;
      color: var(--ink);
      font-size: 13px;
      white-space: nowrap;
    }
    .swatch {
      display: inline-block;
      width: 20px;
      height: 3px;
      border-radius: 999px;
    }
    #chart {
      display: block;
      width: 100%;
      height: 660px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      cursor: crosshair;
    }
    #info {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .kpi {
      display: grid;
      grid-template-columns: repeat(7, minmax(120px, 1fr));
      gap: 8px;
      margin-top: 8px;
    }
    .kpi div {
      border: 1px solid var(--soft-line);
      border-radius: 6px;
      padding: 7px 8px;
      background: #fbfcfe;
      color: var(--muted);
      min-width: 0;
    }
    .kpi b {
      display: block;
      margin-top: 2px;
      color: var(--ink);
      font-size: 15px;
    }
    .tables {
      display: grid;
      grid-template-columns: minmax(360px, 1fr) minmax(520px, 1.45fr);
      gap: 10px;
      align-items: start;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--soft-line);
      padding: 6px 7px;
      text-align: left;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 72px;
      z-index: 1;
      background: #f8fafc;
      color: #475569;
      font-weight: 600;
    }
    tbody tr { cursor: pointer; }
    tbody tr:hover { background: #f8fafc; }
    tbody tr.active { background: #eef6ff; }
    td.num, th.num { text-align: right; }
    .load { color: var(--load); font-weight: 700; }
    .unload { color: var(--unload); font-weight: 700; }
    .artifact { color: var(--artifact); }
    .scroll {
      max-height: 360px;
      overflow: auto;
    }
    #tooltip {
      position: fixed;
      display: none;
      pointer-events: none;
      z-index: 5;
      max-width: 360px;
      border-radius: 6px;
      padding: 8px 9px;
      background: rgba(17, 24, 39, 0.94);
      color: #fff;
      font-size: 12px;
      line-height: 1.35;
    }
    .hint {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    details.advanced {
      margin-top: 10px;
      border-top: 1px solid var(--soft-line);
      padding-top: 8px;
    }
    details.advanced summary {
      color: var(--muted);
      cursor: pointer;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .advanced-controls {
      display: grid;
      grid-template-columns: repeat(8, minmax(92px, 1fr));
      gap: 8px;
      align-items: end;
    }
    @media (max-width: 1250px) {
      .controls { grid-template-columns: 1fr 1fr 1fr 1fr; }
      .advanced-controls { grid-template-columns: 1fr 1fr 1fr 1fr; }
      .kpi { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
      .tables { grid-template-columns: 1fr; }
      #chart { height: 560px; }
    }
    @media (max-width: 720px) {
      .controls { grid-template-columns: 1fr 1fr; }
      .advanced-controls { grid-template-columns: 1fr 1fr; }
      .kpi { grid-template-columns: 1fr 1fr; }
      th { top: 120px; }
      #chart { height: 520px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Weight step markup lab</h1>
    <div class="controls">
      <label>Замес
        <select id="batchSelect"></select>
      </label>
      <label>Мин. загрузка, кг
        <input id="minStepKg" type="number" min="5" max="300" step="5" value="20">
      </label>
      <label>Мин. выгрузка, кг
        <input id="minUnloadStepKg" type="number" min="5" max="600" step="5" value="70">
      </label>
      <label>Стаб. окно
        <input id="stableRadius" type="number" min="1" max="30" step="1" value="10">
      </label>
      <label>Шум плато, кг
        <input id="stableRangeKg" type="number" min="5" max="150" step="5" value="50">
      </label>
      <label>Макс. загрузка, c
        <input id="maxTransitionSec" type="number" min="5" max="1000000" step="5" value="100000">
      </label>
      <label>Макс. выгрузка, c
        <input id="maxUnloadTransitionSec" type="number" min="5" max="1000000" step="5" value="545000">
      </label>
      <label>Плато-якорь, c
        <input id="anchorSec" type="number" min="5" max="90" step="5" value="15">
      </label>
      <label>Калибр. вес
        <input id="weightScale" type="number" min="0.1" max="3" step="0.001" value="1.048">
      </label>
      <label>Дрейф + до, кг
        <input id="loadDriftMaxKg" type="number" min="5" max="200" step="5" value="70">
      </label>
      <label>Всегда загрузка, кг
        <input id="loadForceKg" type="number" min="20" max="500" step="5" value="120">
      </label>
      <label>Загрузка v &gt;
        <input id="loadMovingSpeedKmh" type="number" min="0" max="15" step="0.1" value="0">
      </label>
      <label>Ход загрузки, %
        <input id="loadMovingMaxPct" type="number" min="0" max="100" step="5" value="60">
      </label>
      <button id="resetBtn" type="button">Сброс</button>
    </div>
    <details class="advanced">
      <summary>Тонкие настройки детектора</summary>
      <div class="advanced-controls">
        <label>Макс. плато, c
          <input id="maxPlateauSec" type="number" min="0" max="900" step="5" value="60">
        </label>
        <label>Склейка загрузок, c
          <input id="loadMergeGapSec" type="number" min="0" max="120" step="1" value="10">
        </label>
        <label>Мин. точек плато
          <input id="stableMinPoints" type="number" min="2" max="30" step="1" value="4">
        </label>
        <label>Склейка плато, c
          <input id="plateauMergeGapSec" type="number" min="0" max="120" step="1" value="0">
        </label>
        <label>Порог склейки, кг
          <input id="samePlateauKg" type="number" min="0" max="100" step="5" value="5">
        </label>
        <label>Расширение, мин
          <input id="boundaryMinExtendMin" type="number" min="0" max="20" step="1" value="3">
        </label>
        <label>Движение host &gt;
          <input id="boundarySpeedKmh" type="number" min="0" max="5" step="0.1" value="0">
        </label>
        <label>Отскок окно, c
          <input id="bounceWindowSec" type="number" min="0" max="600" step="5" value="0">
        </label>
        <label>Отскок возврат, кг
          <input id="bounceReturnKg" type="number" min="0" max="300" step="5" value="70">
        </label>
        <label>Просадка до, кг
          <input id="movementDipKg" type="number" min="0" max="300" step="5" value="80">
        </label>
        <label>Просадка v avg
          <input id="movementDipSpeedKmh" type="number" min="0" max="15" step="0.1" value="3">
        </label>
        <label>Край плато мин, c
          <input id="edgePlateauMinSec" type="number" min="0" max="120" step="1" value="40">
        </label>
        <label>Край плато макс, c
          <input id="edgePlateauMaxSec" type="number" min="0" max="300" step="5" value="60">
        </label>
        <label>Край плато шум, кг
          <input id="edgePlateauRangeKg" type="number" min="0" max="150" step="5" value="25">
        </label>
        <label>Старт мягче, мин
          <input id="startSoftWindowMin" type="number" min="0" max="15" step="1" value="4">
        </label>
        <label>Старт мин. загр, кг
          <input id="startSoftMinLoadKg" type="number" min="0" max="150" step="5" value="30">
        </label>
        <label>Старт мин. плато, c
          <input id="startSoftPlateauMinSec" type="number" min="0" max="120" step="5" value="20">
        </label>
        <label>Старт шум, кг
          <input id="startSoftPlateauRangeKg" type="number" min="0" max="100" step="5" value="30">
        </label>
        <label>Raw обрыв &lt;, кг
          <input id="rawCutoffKg" type="number" min="-5000" max="5000" step="50" value="-1000">
        </label>
        <label>Raw обрыв падение, кг
          <input id="rawCutoffDropKg" type="number" min="0" max="5000" step="50" value="500">
        </label>
      </div>
    </details>
  </header>

  <main>
    <section class="panel">
      <div class="toggles" id="toggles"></div>
      <div class="hint">Фильтр фиксированный: rawWeight -> Hampel radius 10, sigma 1 -> rolling median radius 8 -> округление 5 кг. Событие считается отдельной ступенькой между соседними стабильными плато; окно анализа расширяется за старые границы замеса минимум на 3 минуты и до ближайшего движения host.</div>
    </section>
    <section class="panel" id="info"></section>
    <canvas id="chart"></canvas>
    <section class="tables">
      <div class="panel">
        <b>Замесы 29-46</b>
        <div class="scroll"><table id="summaryTable"></table></div>
      </div>
      <div class="panel">
        <b>Ступеньки выбранного замеса</b>
        <div class="scroll"><table id="eventsTable"></table></div>
      </div>
    </section>
  </main>
  <div id="tooltip"></div>

  <script>
    window.WEIGHT_STEP_MARKUP_DATA = ${escapeScriptJson(payload)};
  </script>
  <script>
    const DATA = window.WEIGHT_STEP_MARKUP_DATA;
    const FILTER = DATA.filter;
    const COLORS = {
      filtered: '#136f63',
      raw: '#94a3b8',
      weight: '#334155',
      plateau: '#2563eb',
      load: '#168a4a',
      unload: '#dc2626',
      artifact: '#7c8797',
      speed: '#64748b'
    };
    const state = {
      hoverX: null,
      showRaw: false,
      showTelemetryWeight: false,
      showFiltered: true,
      showSpeed: true,
      showPlateaus: true,
      showEvents: true,
      showOldIngredients: false,
      excludeBounceDips: true
    };

    const batchSelect = document.getElementById('batchSelect');
    const toggles = document.getElementById('toggles');
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const info = document.getElementById('info');
    const tooltip = document.getElementById('tooltip');
    const summaryTable = document.getElementById('summaryTable');
    const eventsTable = document.getElementById('eventsTable');

    function ts(value) {
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : null;
    }

    function finite(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function kg(value) {
      return Number.isFinite(Number(value)) ? Math.round(Number(value)) : '-';
    }

    function sec(value) {
      return Number.isFinite(Number(value)) ? Math.round(Number(value) / 1000) : '-';
    }

    function localTime(value) {
      return new Date(value).toLocaleTimeString('ru-RU', { timeZone: DATA.timezone });
    }

    function localDateTime(value) {
      return new Date(value).toLocaleString('ru-RU', { timeZone: DATA.timezone });
    }

    function median(values) {
      const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
      if (!sorted.length) return null;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function quantile(values, q) {
      const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
      if (!sorted.length) return null;
      const pos = (sorted.length - 1) * q;
      const base = Math.floor(pos);
      const rest = pos - base;
      return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }

    function rollingMedian(values, radius) {
      if (radius <= 0) return values.slice();
      return values.map((value, index) => {
        const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1));
        return median(slice) ?? value;
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

    function roundStep(value, step) {
      return Number.isFinite(value) ? Math.round(value / step) * step : value;
    }

    function eventLevel(value) {
      return roundStep(Number(value), FILTER.roundToKg);
    }

    function eventDelta(beforeLevel, afterLevel) {
      if (!Number.isFinite(beforeLevel) || !Number.isFinite(afterLevel)) return null;
      return eventLevel(afterLevel) - eventLevel(beforeLevel);
    }

    function options() {
      const weightScale = Number(document.getElementById('weightScale').value);
      const loadForceKg = Number(document.getElementById('loadForceKg').value);
      const loadMovingSpeedKmh = Number(document.getElementById('loadMovingSpeedKmh').value);
      const loadMovingMaxPct = Number(document.getElementById('loadMovingMaxPct').value);
      const maxPlateauSec = Number(document.getElementById('maxPlateauSec').value);
      const loadMergeGapSec = Number(document.getElementById('loadMergeGapSec').value);
      const stableMinPoints = Number(document.getElementById('stableMinPoints').value);
      const plateauMergeGapSec = Number(document.getElementById('plateauMergeGapSec').value);
      const samePlateauKg = Number(document.getElementById('samePlateauKg').value);
      const boundaryMinExtendMin = Number(document.getElementById('boundaryMinExtendMin').value);
      const boundarySpeedKmh = Number(document.getElementById('boundarySpeedKmh').value);
      const bounceWindowSec = Number(document.getElementById('bounceWindowSec').value);
      const bounceReturnKg = Number(document.getElementById('bounceReturnKg').value);
      const movementDipKg = Number(document.getElementById('movementDipKg').value);
      const movementDipSpeedKmh = Number(document.getElementById('movementDipSpeedKmh').value);
      const edgePlateauMinSec = Number(document.getElementById('edgePlateauMinSec').value);
      const edgePlateauMaxSec = Number(document.getElementById('edgePlateauMaxSec').value);
      const edgePlateauRangeKg = Number(document.getElementById('edgePlateauRangeKg').value);
      const startSoftWindowMin = Number(document.getElementById('startSoftWindowMin').value);
      const startSoftMinLoadKg = Number(document.getElementById('startSoftMinLoadKg').value);
      const startSoftPlateauMinSec = Number(document.getElementById('startSoftPlateauMinSec').value);
      const startSoftPlateauRangeKg = Number(document.getElementById('startSoftPlateauRangeKg').value);
      const rawCutoffKg = Number(document.getElementById('rawCutoffKg').value);
      const rawCutoffDropKg = Number(document.getElementById('rawCutoffDropKg').value);
      return {
        minLoadStepKg: Number(document.getElementById('minStepKg').value) || 20,
        minUnloadStepKg: Number(document.getElementById('minUnloadStepKg').value) || 70,
        stableRadius: Number(document.getElementById('stableRadius').value) || 10,
        stableRangeKg: Number(document.getElementById('stableRangeKg').value) || 50,
        maxLoadTransitionSec: Number(document.getElementById('maxTransitionSec').value) || 100000,
        maxUnloadTransitionSec: Number(document.getElementById('maxUnloadTransitionSec').value) || 545000,
        anchorSec: Number(document.getElementById('anchorSec').value) || 15,
        weightScale: Number.isFinite(weightScale) && weightScale > 0 ? weightScale : 1.048,
        loadDriftMaxKg: Number(document.getElementById('loadDriftMaxKg').value) || 70,
        loadForceKg: Number.isFinite(loadForceKg) ? loadForceKg : 120,
        loadMovingSpeedKmh: Number.isFinite(loadMovingSpeedKmh) ? loadMovingSpeedKmh : 0,
        loadMovingMaxPct: Number.isFinite(loadMovingMaxPct) ? loadMovingMaxPct : 60,
        maxPlateauSec: Number.isFinite(maxPlateauSec) ? maxPlateauSec : 60,
        loadMergeGapSec: Number.isFinite(loadMergeGapSec) ? loadMergeGapSec : 10,
        boundaryMinExtendMs: (Number.isFinite(boundaryMinExtendMin) ? boundaryMinExtendMin : 3) * 60 * 1000,
        boundarySpeedKmh: Number.isFinite(boundarySpeedKmh) ? boundarySpeedKmh : 0,
        stableMinPoints: Number.isFinite(stableMinPoints) ? stableMinPoints : 4,
        plateauMergeGapSec: Number.isFinite(plateauMergeGapSec) ? plateauMergeGapSec : 0,
        samePlateauKg: Number.isFinite(samePlateauKg) ? samePlateauKg : 5,
        bounceWindowSec: Number.isFinite(bounceWindowSec) ? bounceWindowSec : 0,
        bounceReturnKg: Number.isFinite(bounceReturnKg) ? bounceReturnKg : 70,
        movementDipKg: Number.isFinite(movementDipKg) ? movementDipKg : 80,
        movementDipSpeedKmh: Number.isFinite(movementDipSpeedKmh) ? movementDipSpeedKmh : 3,
        edgePlateauMinSec: Number.isFinite(edgePlateauMinSec) ? edgePlateauMinSec : 40,
        edgePlateauMaxSec: Number.isFinite(edgePlateauMaxSec) ? edgePlateauMaxSec : 60,
        edgePlateauRangeKg: Number.isFinite(edgePlateauRangeKg) ? edgePlateauRangeKg : 25,
        startSoftWindowMs: (Number.isFinite(startSoftWindowMin) ? startSoftWindowMin : 4) * 60 * 1000,
        startSoftMinLoadKg: Number.isFinite(startSoftMinLoadKg) ? startSoftMinLoadKg : 30,
        startSoftPlateauMinSec: Number.isFinite(startSoftPlateauMinSec) ? startSoftPlateauMinSec : 20,
        startSoftPlateauRangeKg: Number.isFinite(startSoftPlateauRangeKg) ? startSoftPlateauRangeKg : 30,
        rawCutoffKg: Number.isFinite(rawCutoffKg) ? rawCutoffKg : -1000,
        rawCutoffDropKg: Number.isFinite(rawCutoffDropKg) ? rawCutoffDropKg : 500
      };
    }

    function selectedBatch() {
      return DATA.batches.find((batch) => String(batch.id) === batchSelect.value) || DATA.batches[0];
    }

    function scaleWeight(value, scale) {
      return Number.isFinite(value) ? value * scale : value;
    }

    function buildFilteredPoints(batch, opts = options()) {
      const weightScale = Number.isFinite(opts.weightScale) && opts.weightScale > 0 ? opts.weightScale : 1.048;
      const points = batch.telemetry.map((row) => ({
        x: ts(row.t),
        raw: scaleWeight(finite(row.r), weightScale),
        weight: scaleWeight(finite(row.w), weightScale),
        speed: finite(row.s),
        lat: finite(row.lat),
        lon: finite(row.lon)
      })).filter((point) => Number.isFinite(point.x));

      const cutoffKg = Number(opts.rawCutoffKg);
      const cutoffDropKg = Number(opts.rawCutoffDropKg);
      let usablePoints = points;
      let terminalCutoff = false;
      if (Number.isFinite(cutoffKg) && Number.isFinite(cutoffDropKg) && cutoffDropKg >= 0) {
        for (let index = 1; index < points.length; index += 1) {
          const previous = points[index - 1];
          const current = points[index];
          if (
            Number.isFinite(previous.raw) &&
            Number.isFinite(current.raw) &&
            previous.raw > cutoffKg &&
            current.raw < cutoffKg &&
            previous.raw - current.raw >= cutoffDropKg
          ) {
            usablePoints = points.slice(0, index);
            terminalCutoff = true;
            break;
          }
        }
      }

      const rawValues = usablePoints.map((point) => Number.isFinite(point.raw) ? point.raw : point.weight);
      const filtered = rollingMedian(hampel(rawValues, FILTER.hampelRadius, FILTER.hampelSigma), FILTER.rollingMedianRadius)
        .map((value) => roundStep(value, FILTER.roundToKg));
      if (terminalCutoff && filtered.length) {
        filtered[filtered.length - 1] = roundStep(rawValues[rawValues.length - 1], FILTER.roundToKg);
      }

      return usablePoints.map((point, index) => ({
        ...point,
        filtered: filtered[index]
      })).filter((point) => Number.isFinite(point.filtered));
    }

    function summarizePoints(points, anchorMs = null, preferEnd = false) {
      let selected = points;
      if (Number.isFinite(anchorMs)) {
        selected = preferEnd
          ? points.filter((point) => point.x >= points[points.length - 1].x - anchorMs)
          : points.filter((point) => point.x <= points[0].x + anchorMs);
        if (selected.length < 2) selected = points;
      }
      const weights = selected.map((point) => point.filtered).filter(Number.isFinite);
      const speeds = selected.map((point) => point.speed).filter(Number.isFinite);
      return {
        level: median(weights),
        q10: quantile(weights, 0.1),
        q90: quantile(weights, 0.9),
        points: selected.length,
        avgSpeed: speeds.length ? speeds.reduce((sum, item) => sum + Math.abs(item), 0) / speeds.length : null
      };
    }

    function plateauLevel(plateau, side, opts) {
      if (Number.isFinite(plateau?.level)) return plateau.level;
      const anchor = side === 'right' ? plateau?.beforeAnchor : plateau?.afterAnchor;
      if (anchor && Number.isFinite(anchor.level)) return anchor.level;
      const source = Array.isArray(plateau?.source) ? plateau.source : [];
      return summarizePoints(source, opts.anchorSec * 1000, side === 'right').level;
    }

    function splitStableRun(run, opts) {
      const maxMs = Number(opts.maxPlateauSec) > 0 ? Number(opts.maxPlateauSec) * 1000 : 0;
      if (!maxMs || run.length < 2 || run[run.length - 1].x - run[0].x <= maxMs) {
        return [{ points: run, capped: false }];
      }

      const startEndMs = run[0].x + maxMs;
      const endStartMs = run[run.length - 1].x - maxMs;
      const startPart = run.filter((point) => point.x <= startEndMs);
      const endPart = run.filter((point) => point.x >= endStartMs);
      const parts = [];
      if (startPart.length >= opts.stableMinPoints) parts.push({ points: startPart, capped: true });
      if (
        endPart.length >= opts.stableMinPoints &&
        (!startPart.length || endPart[0].x > startPart[startPart.length - 1].x)
      ) {
        parts.push({ points: endPart, capped: true });
      }
      return parts.length ? parts : [{ points: run, capped: false }];
    }

    function decoratePlateaus(plateaus, opts) {
      const anchorMs = opts.anchorSec * 1000;
      return plateaus.map((plateau, index) => ({
        ...plateau,
        index,
        beforeAnchor: summarizePoints(plateau.source, anchorMs, true),
        afterAnchor: summarizePoints(plateau.source, anchorMs, false)
      }));
    }

    function buildPlateaus(points, opts) {
      const marked = points.map((point, index) => {
        const window = points.slice(Math.max(0, index - opts.stableRadius), Math.min(points.length, index + opts.stableRadius + 1));
        const weights = window.map((item) => item.filtered).filter(Number.isFinite);
        const q10 = quantile(weights, 0.1);
        const q90 = quantile(weights, 0.9);
        const range = Number.isFinite(q10) && Number.isFinite(q90) ? q90 - q10 : Number.POSITIVE_INFINITY;
        return {
          ...point,
          stable: weights.length >= opts.stableMinPoints && range <= opts.stableRangeKg,
          localRangeKg: range
        };
      });

      const runs = [];
      let current = [];
      for (const point of marked) {
        if (point.stable) {
          current.push(point);
          continue;
        }
        if (current.length >= opts.stableMinPoints) runs.push(current);
        current = [];
      }
      if (current.length >= opts.stableMinPoints) runs.push(current);

      const plateauRuns = runs.flatMap((run) => splitStableRun(run, opts));
      const plateaus = plateauRuns.map((item, index) => {
        const run = item.points;
        const summary = summarizePoints(run);
        return {
          index,
          capped: item.capped,
          startMs: run[0].x,
          endMs: run[run.length - 1].x,
          startTime: run[0].x,
          endTime: run[run.length - 1].x,
          level: summary.level,
          q10: summary.q10,
          q90: summary.q90,
          points: run.length,
          source: run
        };
      });

      const merged = [];
      for (const plateau of plateaus) {
        const prev = merged[merged.length - 1];
        if (
          prev &&
          !prev.capped &&
          !plateau.capped &&
          plateau.startMs - prev.endMs <= opts.plateauMergeGapSec * 1000 &&
          Math.abs(Number(plateau.level) - Number(prev.level)) <= opts.samePlateauKg
        ) {
          const source = prev.source.concat(plateau.source);
          const summary = summarizePoints(source);
          prev.endMs = plateau.endMs;
          prev.endTime = plateau.endTime;
          prev.level = summary.level;
          prev.q10 = summary.q10;
          prev.q90 = summary.q90;
          prev.points = source.length;
          prev.source = source;
          continue;
        }
        merged.push({ ...plateau });
      }

      return decoratePlateaus(merged, opts);
    }

    function buildTransitionPlateaus(points, from, to, opts, batchStartMs = null) {
      const transitionPoints = points.filter((point) => point.x > from.endMs && point.x < to.startMs);
      if (transitionPoints.length < opts.stableMinPoints) return [];

      const minMs = Math.max(0, Number(opts.edgePlateauMinSec) || 0) * 1000;
      const fromLevel = eventLevel(plateauLevel(from, 'right', opts));
      const toLevel = eventLevel(plateauLevel(to, 'left', opts));
      const softStartEndMs = Number.isFinite(batchStartMs)
        ? batchStartMs + Math.max(0, Number(opts.startSoftWindowMs) || 0)
        : null;
      const marked = transitionPoints.map((point, index) => {
        const window = transitionPoints.slice(Math.max(0, index - opts.stableRadius), Math.min(transitionPoints.length, index + opts.stableRadius + 1));
        const weights = window.map((item) => item.filtered).filter(Number.isFinite);
        const q10 = quantile(weights, 0.1);
        const q90 = quantile(weights, 0.9);
        const range = Number.isFinite(q10) && Number.isFinite(q90) ? q90 - q10 : Number.POSITIVE_INFINITY;
        return {
          ...point,
          stable: weights.length >= opts.stableMinPoints && range <= opts.stableRangeKg
        };
      });

      const runs = [];
      let current = [];
      for (const point of marked) {
        if (point.stable) {
          current.push(point);
          continue;
        }
        if (current.length >= opts.stableMinPoints) runs.push(current);
        current = [];
      }
      if (current.length >= opts.stableMinPoints) runs.push(current);

      const candidates = [];
      const addCandidate = (run, capped = false, reason = 'stable-transition') => {
        const summary = summarizePoints(run);
        if (!Number.isFinite(summary.level)) return;
        const candidate = {
          synthetic: true,
          inserted: true,
          insertedReason: reason,
          capped,
          startMs: run[0].x,
          endMs: run[run.length - 1].x,
          startTime: run[0].x,
          endTime: run[run.length - 1].x,
          level: summary.level,
          q10: summary.q10,
          q90: summary.q90,
          points: run.length,
          source: run
        };
        const overlaps = candidates.some((item) => candidate.startMs <= item.endMs && candidate.endMs >= item.startMs);
        if (!overlaps) candidates.push(candidate);
      };

      for (const item of runs.flatMap((run) => splitStableRun(run, opts))) {
        const run = item.points;
        const durationMs = run[run.length - 1].x - run[0].x;
        if (minMs && durationMs + 1000 < minMs) continue;
        addCandidate(run, item.capped);
      }

      const inStartSoftZone = Number.isFinite(softStartEndMs) &&
        from.endMs <= softStartEndMs &&
        transitionPoints[0]?.x <= softStartEndMs;

      if (inStartSoftZone && Number.isFinite(fromLevel) && Number.isFinite(toLevel) && toLevel - fromLevel >= 150) {
        let flatRun = [];
        const flushFlatRun = () => {
          if (flatRun.length >= opts.stableMinPoints) {
            const durationMs = flatRun[flatRun.length - 1].x - flatRun[0].x;
            const weights = flatRun.map((point) => point.filtered).filter(Number.isFinite);
            const level = eventLevel(median(weights));
            const firstDelta = level - fromLevel;
            const remainingDelta = toLevel - level;
            if (
              durationMs >= Math.max(0, Number(opts.startSoftPlateauMinSec) || 0) * 1000 &&
              firstDelta >= opts.startSoftMinLoadKg &&
              firstDelta < 150 &&
              remainingDelta >= opts.minLoadStepKg
            ) {
              addCandidate(flatRun, false, 'short-load-shelf');
            }
          }
          flatRun = [];
        };

        for (const point of transitionPoints) {
          const nextRun = flatRun.concat(point);
          const weights = nextRun.map((item) => item.filtered).filter(Number.isFinite);
          const range = Math.max(...weights) - Math.min(...weights);
          const net = Math.abs(nextRun[nextRun.length - 1].filtered - nextRun[0].filtered);
          if (range <= opts.startSoftPlateauRangeKg && net <= opts.startSoftPlateauRangeKg) {
            flatRun = nextRun;
          } else {
            flushFlatRun();
            flatRun = [point];
          }
        }
        flushFlatRun();
      }

      const firstShortShelfIndex = candidates.findIndex((candidate) => candidate.insertedReason === 'short-load-shelf');
      if (firstShortShelfIndex >= 0) {
        return candidates.filter((candidate, index) =>
          candidate.insertedReason !== 'short-load-shelf' || index === firstShortShelfIndex
        );
      }

      return candidates;
    }

    function insertTransitionPlateaus(points, plateaus, opts, batchStartMs = null) {
      if (plateaus.length < 2) return plateaus;
      const result = [];
      for (let index = 0; index < plateaus.length - 1; index += 1) {
        const from = plateaus[index];
        const to = plateaus[index + 1];
        result.push(from);
        const candidates = buildTransitionPlateaus(points, from, to, opts, batchStartMs);
        for (const candidate of candidates) {
          const farFromLeft = candidate.startMs - from.endMs > 1000;
          const farFromRight = to.startMs - candidate.endMs > 1000;
          if (farFromLeft && farFromRight) result.push(candidate);
        }
      }
      result.push(plateaus[plateaus.length - 1]);
      result.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
      return decoratePlateaus(result, opts);
    }

    function speedSummary(points, fromMs, toMs, movingSpeedKmh = 0.1) {
      const selected = points.filter((point) => point.x >= fromMs && point.x <= toMs);
      const speeds = selected
        .map((point) => Math.abs(point.speed))
        .filter(Number.isFinite);
      if (!speeds.length) return { avg: null, max: null, movingPct: null };
      let movingMs = 0;
      let coveredMs = 0;
      for (let index = 0; index < selected.length; index += 1) {
        const point = selected[index];
        const next = selected[index + 1];
        const segmentStart = Math.max(fromMs, point.x);
        const segmentEnd = Math.min(toMs, next?.x ?? toMs);
        const segmentMs = Math.max(0, segmentEnd - segmentStart);
        if (!segmentMs) continue;
        coveredMs += segmentMs;
        if (Number.isFinite(point.speed) && Math.abs(point.speed) > movingSpeedKmh) {
          movingMs += segmentMs;
        }
      }
      return {
        avg: speeds.reduce((sum, item) => sum + item, 0) / speeds.length,
        max: Math.max(...speeds),
        movingPct: coveredMs > 0 ? (movingMs / coveredMs) * 100 : null
      };
    }

    function eventKind(delta) {
      if (delta > 0) return 'load';
      if (delta < 0) return 'unload';
      return 'flat';
    }

    function summarizeEdgePlateau(points) {
      const weights = points.map((point) => point.filtered).filter(Number.isFinite);
      return {
        startMs: points[0].x,
        endMs: points[points.length - 1].x,
        level: median(weights),
        range: (quantile(weights, 0.9) ?? Number.POSITIVE_INFINITY) - (quantile(weights, 0.1) ?? 0),
        points: points.length
      };
    }

    function findEdgePlateau(points, side, opts) {
      const minMs = Math.max(0, Number(opts.edgePlateauMinSec) || 0) * 1000;
      const maxMs = Math.max(minMs, Number(opts.edgePlateauMaxSec) || 0) * 1000;
      if (!minMs || points.length < opts.stableMinPoints) return null;

      const ordered = side === 'start' ? points : points.slice().reverse();
      const origin = ordered[0].x;
      let best = null;
      for (let count = opts.stableMinPoints; count <= ordered.length; count += 1) {
        const candidate = ordered.slice(0, count).slice().sort((left, right) => left.x - right.x);
        const durationMs = candidate[candidate.length - 1].x - candidate[0].x;
        const edgeDurationMs = Math.abs(ordered[count - 1].x - origin);
        if (edgeDurationMs > maxMs) break;
        if (durationMs < minMs) continue;
        const summary = summarizeEdgePlateau(candidate);
        const net = Math.abs(candidate[candidate.length - 1].filtered - candidate[0].filtered);
        if (
          Number.isFinite(summary.level) &&
          summary.range <= opts.edgePlateauRangeKg &&
          net <= opts.edgePlateauRangeKg
        ) {
          best = summary;
        }
      }

      return best;
    }

    function trimTransitionEdges(points, from, to, opts) {
      const leftLevel = plateauLevel(from, 'right', opts);
      const rightLevel = plateauLevel(to, 'left', opts);
      const leftPlateauStartMs = Math.max(from.startMs, from.endMs - opts.anchorSec * 1000);
      const leftPlateauEndMs = from.endMs;
      const rightPlateauStartMs = to.startMs;
      const rightPlateauEndMs = Math.min(to.endMs, to.startMs + opts.anchorSec * 1000);
      const transitionPoints = points.filter((point) => point.x >= from.endMs && point.x <= to.startMs);
      if (transitionPoints.length < opts.stableMinPoints * 2) {
        return {
          startMs: from.endMs,
          endMs: to.startMs,
          beforeLevel: leftLevel,
          afterLevel: rightLevel,
          beforePlateauStartMs: leftPlateauStartMs,
          beforePlateauEndMs: leftPlateauEndMs,
          afterPlateauStartMs: rightPlateauStartMs,
          afterPlateauEndMs: rightPlateauEndMs,
          edgeStart: null,
          edgeEnd: null
        };
      }

      const edgeStart = findEdgePlateau(transitionPoints, 'start', opts);
      const afterStartMs = edgeStart ? edgeStart.endMs : from.endMs;
      const endCandidates = transitionPoints.filter((point) => point.x >= afterStartMs);
      const edgeEnd = findEdgePlateau(endCandidates, 'end', opts);
      const startMs = edgeStart ? edgeStart.endMs : from.endMs;
      const endMs = edgeEnd ? edgeEnd.startMs : to.startMs;

      if (startMs >= endMs) {
        return {
          startMs: from.endMs,
          endMs: to.startMs,
          beforeLevel: leftLevel,
          afterLevel: rightLevel,
          beforePlateauStartMs: leftPlateauStartMs,
          beforePlateauEndMs: leftPlateauEndMs,
          afterPlateauStartMs: rightPlateauStartMs,
          afterPlateauEndMs: rightPlateauEndMs,
          edgeStart: null,
          edgeEnd: null
        };
      }

      return {
        startMs,
        endMs,
        beforeLevel: leftLevel,
        afterLevel: rightLevel,
        beforePlateauStartMs: leftPlateauStartMs,
        beforePlateauEndMs: leftPlateauEndMs,
        afterPlateauStartMs: rightPlateauStartMs,
        afterPlateauEndMs: rightPlateauEndMs,
        edgeStart,
        edgeEnd
      };
    }

    function moving(point, opts) {
      return Number.isFinite(point?.speed) && Math.abs(point.speed) > opts.boundarySpeedKmh;
    }

    function findAnalysisBounds(points, batchStartMs, batchEndMs, opts) {
      const minStart = batchStartMs - opts.boundaryMinExtendMs;
      const minEnd = batchEndMs + opts.boundaryMinExtendMs;
      const firstPointMs = points[0]?.x ?? minStart;
      const lastPointMs = points[points.length - 1]?.x ?? minEnd;
      let startMs = Math.max(firstPointMs, minStart);
      let endMs = Math.min(lastPointMs, minEnd);

      for (let index = points.length - 1; index >= 0; index -= 1) {
        const point = points[index];
        if (point.x > minStart) continue;
        if (moving(point, opts)) {
          startMs = Math.max(firstPointMs, point.x);
          break;
        }
      }

      for (const point of points) {
        if (point.x < minEnd) continue;
        if (moving(point, opts)) {
          endMs = Math.min(lastPointMs, point.x);
          break;
        }
      }

      if (startMs >= batchStartMs) startMs = Math.max(firstPointMs, minStart);
      if (endMs <= batchEndMs) endMs = Math.min(lastPointMs, minEnd);

      return { startMs, endMs, minStart, minEnd };
    }

    function markBounceArtifacts(events, opts) {
      const marked = events.map((event) => {
        const forceLoad = event.delta > 0 && event.absKg >= opts.loadForceKg;
        const movingSmallDrop = event.delta < 0 &&
          event.absKg <= opts.movementDipKg &&
          Number.isFinite(event.speedAvg) &&
          event.speedAvg >= opts.movementDipSpeedKmh;
        const mostlyMovingLoad = event.delta > 0 &&
          !forceLoad &&
          Number.isFinite(event.movingPct) &&
          event.movingPct > opts.loadMovingMaxPct;
        const movingSmallLoad = event.delta > 0 &&
          !forceLoad &&
          event.absKg <= opts.loadDriftMaxKg &&
          Number.isFinite(event.movingPct) &&
          event.movingPct > Math.min(40, opts.loadMovingMaxPct);
        const artifactReason = mostlyMovingLoad
          ? 'moving-load-percent'
          : movingSmallLoad
          ? 'moving-load-drift'
          : movingSmallDrop
            ? 'moving-dip'
            : '';
        return {
          ...event,
          forceLoad,
          artifact: movingSmallDrop || movingSmallLoad || mostlyMovingLoad,
          artifactReason
        };
      });
      if (!state.excludeBounceDips) return marked;

      for (let i = 0; i < marked.length - 1; i += 1) {
        const first = marked[i];
        const second = marked[i + 1];
        const opposite = first.delta * second.delta < 0;
        const shortEnough = second.endMs - first.startMs <= opts.bounceWindowSec * 1000;
        const returnsNearStart = Math.abs(Number(second.afterLevel) - Number(first.beforeLevel)) <= opts.bounceReturnKg;
        if (opposite && shortEnough && returnsNearStart) {
          first.artifact = true;
          second.artifact = true;
          first.artifactReason = 'rebound';
          second.artifactReason = 'rebound';
          i += 1;
        }
      }

      return marked;
    }

    function markBatchLifecycleArtifacts(events) {
      const counted = events.filter((event) => !event.artifact);
      const firstLoad = counted.find((event) => event.delta > 0);
      const lastUnload = counted.slice().reverse().find((event) => event.delta < 0);
      let seenStrongUnload = false;
      const strongUnloads = counted.filter((event) => event.delta < 0 && event.absKg > 200);

      return events.map((event) => {
        if (event.artifact) return event;
        if (firstLoad && event.delta < 0 && event.endMs <= firstLoad.startMs) {
          return {
            ...event,
            artifact: true,
            artifactReason: 'before-first-load'
          };
        }
        if (lastUnload && event.delta > 0 && event.startMs >= lastUnload.endMs) {
          return {
            ...event,
            artifact: true,
            artifactReason: 'after-last-unload'
          };
        }
        if (seenStrongUnload && event.delta > 0 && event.absKg < 150) {
          return {
            ...event,
            artifact: true,
            artifactReason: 'small-load-after-unload'
          };
        }
        if (event.delta > 0 && event.absKg < 150) {
          const beforeStrongUnload = strongUnloads.some((unload) => {
            const gapMs = unload.startMs - event.endMs;
            return gapMs >= 0 && gapMs <= 90 * 1000;
          });
          if (beforeStrongUnload) {
            return {
              ...event,
              artifact: true,
              artifactReason: 'small-load-before-unload'
            };
          }
        }
        if (event.delta < 0 && event.absKg > 200) {
          seenStrongUnload = true;
        }
        return event;
      });
    }

    function mergeCloseLoadEvents(events, points, opts) {
      const maxGapMs = Math.max(0, Number(opts.loadMergeGapSec) || 0) * 1000;
      if (!maxGapMs || events.length < 2) return events;

      const merged = [];
      for (const event of events) {
        const previous = merged[merged.length - 1];
        const gapMs = previous ? event.startMs - previous.endMs : Number.POSITIVE_INFINITY;
        if (
          previous &&
          previous.kind === 'load' &&
          event.kind === 'load' &&
          gapMs >= 0 &&
          gapMs < maxGapMs
        ) {
          const beforeLevel = eventLevel(previous.beforeLevel);
          const afterLevel = eventLevel(event.afterLevel);
          const delta = eventDelta(beforeLevel, afterLevel);
          if (!Number.isFinite(delta)) continue;
          const speeds = speedSummary(points, previous.startMs, event.endMs, opts.loadMovingSpeedKmh);
          Object.assign(previous, {
            endMs: event.endMs,
            afterPlateauStartMs: event.afterPlateauStartMs,
            afterPlateauEndMs: event.afterPlateauEndMs,
            beforeLevel,
            afterLevel,
            delta,
            absKg: Math.abs(delta),
            transitionMs: event.endMs - previous.startMs,
            speedAvg: speeds.avg,
            speedMax: speeds.max,
            movingPct: speeds.movingPct,
            toPlateau: event.toPlateau,
            mergedCount: Number(previous.mergedCount || 1) + Number(event.mergedCount || 1)
          });
          continue;
        }
        merged.push({ ...event, mergedCount: event.mergedCount || 1 });
      }

      return merged.map((event, index) => ({ ...event, id: index + 1 }));
    }

    function detectSteps(batch, opts = options()) {
      const points = buildFilteredPoints(batch, opts);
      const batchStartMs = ts(batch.startTime);
      const batchEndMs = ts(batch.endTime || batch.startTime);
      const bounds = findAnalysisBounds(points, batchStartMs, batchEndMs, opts);
      const inBatch = points.filter((point) => point.x >= bounds.startMs && point.x <= bounds.endMs);
      const detectedPlateaus = buildPlateaus(inBatch, opts);
      const plateaus = insertTransitionPlateaus(inBatch, addBoundaryPlateaus(inBatch, detectedPlateaus, bounds.startMs, bounds.endMs, opts), opts, batchStartMs);
      const events = [];

      for (let index = 0; index < plateaus.length - 1; index += 1) {
        const from = plateaus[index];
        const to = plateaus[index + 1];
        const trimmed = trimTransitionEdges(inBatch, from, to, opts);
        const transitionMs = trimmed.endMs - trimmed.startMs;
        if (transitionMs < 0) continue;

        const beforeLevel = eventLevel(trimmed.beforeLevel);
        const afterLevel = eventLevel(trimmed.afterLevel);
        const delta = eventDelta(beforeLevel, afterLevel);
        if (!Number.isFinite(delta)) continue;
        const kind = eventKind(delta);
        const minStepKg = kind === 'unload' ? opts.minUnloadStepKg : opts.minLoadStepKg;
        const maxTransitionSec = kind === 'unload' ? opts.maxUnloadTransitionSec : opts.maxLoadTransitionSec;
        if (kind === 'flat' || Math.abs(delta) < minStepKg || transitionMs > maxTransitionSec * 1000) continue;

        const speeds = speedSummary(inBatch, trimmed.startMs, trimmed.endMs, opts.loadMovingSpeedKmh);
        events.push({
          id: events.length + 1,
          startMs: trimmed.startMs,
          endMs: trimmed.endMs,
          beforePlateauStartMs: trimmed.beforePlateauStartMs,
          beforePlateauEndMs: trimmed.beforePlateauEndMs,
          afterPlateauStartMs: trimmed.afterPlateauStartMs,
          afterPlateauEndMs: trimmed.afterPlateauEndMs,
          beforeLevel,
          afterLevel,
          delta,
          absKg: Math.abs(delta),
          kind,
          transitionMs,
          maxTransitionSec,
          minStepKg,
          speedAvg: speeds.avg,
          speedMax: speeds.max,
          movingPct: speeds.movingPct,
          edgeTrimmed: Boolean(trimmed.edgeStart || trimmed.edgeEnd),
          fromPlateau: from.index,
          toPlateau: to.index
        });
      }

      const mergedEvents = mergeCloseLoadEvents(events, inBatch, opts);
      const markedEvents = markBatchLifecycleArtifacts(markBounceArtifacts(mergedEvents, opts));
      const finalEvents = markedEvents.map((event, index) => ({ ...event, id: index + 1 }));
      const included = finalEvents.filter((event) => !event.artifact);
      const loaded = included.filter((event) => event.delta > 0).reduce((sum, event) => sum + event.delta, 0);
      const unloaded = included.filter((event) => event.delta < 0).reduce((sum, event) => sum + Math.abs(event.delta), 0);
      const first = inBatch[0]?.filtered ?? null;
      const last = inBatch[inBatch.length - 1]?.filtered ?? null;
      const min = inBatch.length ? Math.min(...inBatch.map((point) => point.filtered)) : null;
      const max = inBatch.length ? Math.max(...inBatch.map((point) => point.filtered)) : null;

      return {
        batch,
        points,
        inBatch,
        bounds,
        plateaus,
        events: finalEvents,
        includedEvents: included,
        loaded,
        unloaded,
        net: loaded - unloaded,
        observedNet: Number.isFinite(first) && Number.isFinite(last) ? last - first : null,
        range: Number.isFinite(min) && Number.isFinite(max) ? max - min : null,
        first,
        last
      };
    }

    function boundaryPlateau(points, side, opts) {
      if (!points.length) return null;
      const summary = summarizePoints(points);
      const level = summary.level;
      if (!Number.isFinite(level)) return null;
      const edgeSummary = {
        ...summary,
        level
      };
      return {
        index: side === 'start' ? -1 : 999999,
        synthetic: true,
        side,
        startMs: points[0].x,
        endMs: points[points.length - 1].x,
        startTime: points[0].x,
        endTime: points[points.length - 1].x,
        level,
        q10: summary.q10,
        q90: summary.q90,
        points: points.length,
        source: points,
        beforeAnchor: edgeSummary,
        afterAnchor: edgeSummary
      };
    }

    function addBoundaryPlateaus(inBatch, plateaus, batchStartMs, batchEndMs, opts) {
      if (!inBatch.length) return plateaus;
      const anchorMs = opts.anchorSec * 1000;
      const minGapMs = Math.max(5000, anchorMs * 0.45);
      const result = plateaus.slice();
      const startPoints = inBatch.filter((point) => point.x <= batchStartMs + anchorMs);
      const endPoints = inBatch.filter((point) => point.x >= batchEndMs - anchorMs);
      const first = result[0];
      const last = result[result.length - 1];
      const startPlateau = boundaryPlateau(startPoints, 'start', opts);
      const endPlateau = boundaryPlateau(endPoints, 'end', opts);

      if (startPlateau && (!first || first.startMs - startPlateau.endMs >= minGapMs)) {
        result.unshift(startPlateau);
      }
      if (endPlateau && (!last || endPlateau.startMs - last.endMs >= minGapMs)) {
        result.push(endPlateau);
      }

      return result.map((plateau, index) => ({
        ...plateau,
        index
      }));
    }

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(600, Math.floor(rect.width * dpr));
      canvas.height = Math.max(420, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawLine(points, values, xScale, yScale, color, width, dash = []) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
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
      ctx.setLineDash([]);
    }

    function draw() {
      const batch = selectedBatch();
      if (!batch) return;

      resizeCanvas();
      const analysis = detectSteps(batch);
      const points = analysis.points;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const margin = { left: 58, right: 20, top: 22, bottom: state.showSpeed ? 112 : 48 };
      const plotW = Math.max(100, width - margin.left - margin.right);
      const plotH = Math.max(120, height - margin.top - margin.bottom);
      const speedTop = height - 78;
      const speedH = 42;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);

      const xs = points.map((point) => point.x).filter(Number.isFinite);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const yValues = [];
      if (state.showRaw) yValues.push(...points.map((point) => point.raw).filter(Number.isFinite));
      if (state.showTelemetryWeight) yValues.push(...points.map((point) => point.weight).filter(Number.isFinite));
      yValues.push(...points.map((point) => point.filtered).filter(Number.isFinite));
      const minYRaw = Math.min(...yValues);
      const maxYRaw = Math.max(...yValues);
      const padY = Math.max(70, (maxYRaw - minYRaw) * 0.08);
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

      const extendedStartX = xScale(analysis.bounds.startMs);
      const extendedEndX = xScale(analysis.bounds.endMs);
      ctx.fillStyle = 'rgba(100, 116, 139, 0.045)';
      ctx.fillRect(extendedStartX, margin.top, Math.max(1, extendedEndX - extendedStartX), plotH);

      const batchStartX = xScale(ts(batch.startTime));
      const batchEndX = xScale(ts(batch.endTime || batch.startTime));
      ctx.fillStyle = 'rgba(37, 99, 235, 0.055)';
      ctx.fillRect(batchStartX, margin.top, Math.max(1, batchEndX - batchStartX), plotH);
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.45)';
      ctx.setLineDash([5, 5]);
      for (const x of [batchStartX, batchEndX]) {
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotH);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (state.showOldIngredients) {
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.42)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        for (const ingredient of batch.ingredients) {
          const start = ts(ingredient.startedAt);
          const end = ts(ingredient.addedAt);
          for (const xMs of [start, end]) {
            if (!Number.isFinite(xMs)) continue;
            const px = xScale(xMs);
            ctx.beginPath();
            ctx.moveTo(px, margin.top);
            ctx.lineTo(px, margin.top + plotH);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
      }

      if (state.showEvents) {
        let labelRow = 0;
        for (const event of analysis.events) {
          const color = event.artifact ? COLORS.artifact : event.kind === 'load' ? COLORS.load : COLORS.unload;
          const x1 = xScale(event.startMs);
          const x2 = xScale(event.endMs);
          const left = Math.min(x1, x2);
          const bandW = Math.max(3, Math.abs(x2 - x1));
          ctx.fillStyle = event.artifact ? 'rgba(124, 135, 151, 0.12)' : event.kind === 'load' ? 'rgba(22, 138, 74, 0.14)' : 'rgba(220, 38, 38, 0.13)';
          ctx.fillRect(left, margin.top, bandW, plotH);
          ctx.strokeStyle = color;
          ctx.lineWidth = event.artifact ? 1 : 1.5;
          ctx.setLineDash(event.artifact ? [4, 4] : []);
          ctx.beginPath();
          ctx.moveTo(left + bandW / 2, margin.top);
          ctx.lineTo(left + bandW / 2, margin.top + plotH);
          ctx.stroke();
          ctx.setLineDash([]);

          const y = yScale(event.afterLevel);
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(xScale(event.beforePlateauStartMs), yScale(event.beforeLevel));
          ctx.lineTo(xScale(event.beforePlateauEndMs), yScale(event.beforeLevel));
          ctx.moveTo(xScale(event.afterPlateauStartMs), yScale(event.afterLevel));
          ctx.lineTo(xScale(event.afterPlateauEndMs), yScale(event.afterLevel));
          ctx.stroke();

          const label = (event.delta > 0 ? '+' : '') + kg(event.delta) + ' кг';
          const labelX = Math.max(margin.left + 4, Math.min(width - margin.right - 62, left + bandW / 2 - 24));
          const labelY = Math.max(margin.top + 15, Math.min(margin.top + plotH - 6, y - 10 - (labelRow % 3) * 15));
          ctx.fillStyle = color;
          ctx.font = event.artifact ? '11px Arial' : 'bold 12px Arial';
          ctx.fillText(label, labelX, labelY);
          labelRow += 1;
        }
      }

      if (state.showRaw) {
        drawLine(points, points.map((point) => point.raw), xScale, yScale, COLORS.raw, 1.1);
      }
      if (state.showTelemetryWeight) {
        drawLine(points, points.map((point) => point.weight), xScale, yScale, COLORS.weight, 1.1);
      }
      if (state.showFiltered) {
        drawLine(points, points.map((point) => point.filtered), xScale, yScale, COLORS.filtered, 2.1);
      }
      if (state.showPlateaus) {
        for (const plateau of analysis.plateaus) {
          ctx.strokeStyle = COLORS.plateau;
          ctx.lineWidth = 2.2;
          ctx.globalAlpha = 0.78;
          ctx.beginPath();
          ctx.moveTo(xScale(plateau.startMs), yScale(plateau.level));
          ctx.lineTo(xScale(plateau.endMs), yScale(plateau.level));
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      if (state.showSpeed) {
        ctx.strokeStyle = '#e5e7eb';
        ctx.strokeRect(margin.left, speedTop, plotW, speedH);
        const speeds = points.map((point) => point.speed).filter(Number.isFinite);
        const maxS = Math.max(5, Math.ceil(Math.max(...speeds, 0)));
        const ySpeed = (speed) => speedTop + speedH - (Math.max(0, speed) / maxS) * speedH;
        ctx.strokeStyle = COLORS.speed;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let started = false;
        for (const point of points) {
          if (!Number.isFinite(point.speed)) {
            started = false;
            continue;
          }
          const px = xScale(point.x);
          const py = ySpeed(point.speed);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
        ctx.fillStyle = COLORS.speed;
        ctx.font = '12px Arial';
        ctx.fillText('speed 0..' + maxS + ' km/h', margin.left + 4, speedTop - 6);
      }

      if (state.hoverX !== null) {
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(state.hoverX, margin.top);
        ctx.lineTo(state.hoverX, margin.top + plotH);
        ctx.stroke();
      }

      canvas._chartMeta = { minX, maxX, xScale, margin, plotH, analysis };
      renderInfo(analysis);
      renderEventsTable(analysis);
      renderSummaryTable();
    }

    function renderInfo(analysis) {
      const batch = analysis.batch;
      const oldSum = Number(batch.oldIngredientSum || 0);
      const diffLoadedOld = analysis.loaded - oldSum;
      const diffNetObserved = Number.isFinite(analysis.observedNet) ? analysis.net - analysis.observedNet : null;
      info.innerHTML =
        '<b>#' + batch.id + '</b> ' + localDateTime(batch.startTime) + ' - ' + (batch.endTime ? localDateTime(batch.endTime) : '-') +
        ' · ' + (batch.groupName || '-') + ' / ' + (batch.rationName || '-') +
        ' · analysis: ' + localTime(analysis.bounds.startMs) + ' - ' + localTime(analysis.bounds.endMs) +
        ' · points: ' + analysis.inBatch.length + '/' + analysis.points.length +
        ' · generated: ' + localDateTime(DATA.generatedAt) +
        '<div class="kpi">' +
          '<div>Загружено ступеньками<b>' + kg(analysis.loaded) + ' кг</b></div>' +
          '<div>Выгружено ступеньками<b>' + kg(analysis.unloaded) + ' кг</b></div>' +
          '<div>Загрузка - выгрузка<b>' + kg(analysis.net) + ' кг</b></div>' +
          '<div>Конец - старт графика<b>' + kg(analysis.observedNet) + ' кг</b></div>' +
          '<div>Δ net-график<b>' + kg(diffNetObserved) + ' кг</b></div>' +
          '<div>Старая сумма загрузок<b>' + kg(oldSum) + ' кг</b></div>' +
          '<div>Δ load-old<b>' + kg(diffLoadedOld) + ' кг</b></div>' +
        '</div>';
    }

    function renderSummaryTable() {
      const rows = DATA.batches.map((batch) => {
        const analysis = detectSteps(batch);
        const oldSum = Number(batch.oldIngredientSum || 0);
        return {
          batch,
          events: analysis.includedEvents.length,
          loads: analysis.includedEvents.filter((event) => event.delta > 0).length,
          unloads: analysis.includedEvents.filter((event) => event.delta < 0).length,
          loaded: analysis.loaded,
          unloaded: analysis.unloaded,
          net: analysis.net,
          observedNet: analysis.observedNet,
          oldSum,
          diffOld: analysis.loaded - oldSum
        };
      });

      summaryTable.innerHTML =
        '<thead><tr>' +
        '<th>#</th><th>Время</th><th class="num">соб.</th><th class="num">загр.</th><th class="num">выгр.</th><th class="num">old</th><th class="num">Δ</th><th class="num">net</th>' +
        '</tr></thead><tbody>' +
        rows.map((row) => {
          const active = String(row.batch.id) === String(batchSelect.value) ? ' class="active"' : '';
          return '<tr data-batch-id="' + row.batch.id + '"' + active + '>' +
            '<td>#' + row.batch.id + '</td>' +
            '<td>' + localTime(row.batch.startTime) + '</td>' +
            '<td class="num">' + row.events + '</td>' +
            '<td class="num load">' + kg(row.loaded) + '</td>' +
            '<td class="num unload">' + kg(row.unloaded) + '</td>' +
            '<td class="num">' + kg(row.oldSum) + '</td>' +
            '<td class="num">' + kg(row.diffOld) + '</td>' +
            '<td class="num">' + kg(row.net) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody>';
    }

    function eventTypeLabel(event) {
      if (!event.artifact) return event.kind === 'load' ? 'загрузка' : 'выгрузка';
      if (event.artifactReason === 'moving-load-percent') return 'ход%?';
      if (event.artifactReason === 'moving-load-drift') return 'дрейф?';
      if (event.artifactReason === 'rebound') return 'отскок?';
      if (event.artifactReason === 'before-first-load') return 'до загрузки?';
      if (event.artifactReason === 'after-last-unload') return 'после выгрузки?';
      if (event.artifactReason === 'small-load-after-unload') return 'мелк. после выгрузки?';
      if (event.artifactReason === 'small-load-before-unload') return 'мелк. перед выгрузкой?';
      return 'просадка?';
    }

    function renderEventsTable(analysis) {
      eventsTable.innerHTML =
        '<thead><tr>' +
        '<th>#</th><th>Тип</th><th>Переход</th><th class="num">кг</th><th class="num">до</th><th class="num">после</th><th class="num">сек</th><th class="num">ход%</th><th class="num">v avg</th><th class="num">v max</th>' +
        '</tr></thead><tbody>' +
        analysis.events.map((event) => {
          const type = eventTypeLabel(event) + (event.mergedCount > 1 ? ' x' + event.mergedCount : '') + (event.edgeTrimmed ? ' trim' : '');
          const cls = event.artifact ? 'artifact' : event.kind;
          return '<tr data-event-id="' + event.id + '">' +
            '<td>' + event.id + '</td>' +
            '<td class="' + cls + '">' + type + '</td>' +
            '<td>' + localTime(event.startMs) + ' - ' + localTime(event.endMs) + '</td>' +
            '<td class="num ' + cls + '">' + (event.delta > 0 ? '+' : '') + kg(event.delta) + '</td>' +
            '<td class="num">' + kg(event.beforeLevel) + '</td>' +
            '<td class="num">' + kg(event.afterLevel) + '</td>' +
            '<td class="num">' + sec(event.transitionMs) + '</td>' +
            '<td class="num">' + (Number.isFinite(event.movingPct) ? Math.round(event.movingPct) : '-') + '</td>' +
            '<td class="num">' + (Number.isFinite(event.speedAvg) ? event.speedAvg.toFixed(1) : '-') + '</td>' +
            '<td class="num">' + (Number.isFinite(event.speedMax) ? event.speedMax.toFixed(1) : '-') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody>';
    }

    function renderToggles() {
      const items = [
        ['showFiltered', 'filtered rawWeight', COLORS.filtered],
        ['showRaw', 'rawWeight', COLORS.raw],
        ['showTelemetryWeight', 'Telemetry.weight', COLORS.weight],
        ['showPlateaus', 'плато', COLORS.plateau],
        ['showEvents', 'ступеньки', COLORS.load],
        ['showOldIngredients', 'старые линии ингредиентов', '#64748b'],
        ['showSpeed', 'скорость снизу', COLORS.speed],
        ['excludeBounceDips', 'не считать дрейф/просадки на ходу', COLORS.artifact]
      ];
      toggles.innerHTML = items.map((item) =>
        '<label><input type="checkbox" data-toggle="' + item[0] + '"' + (state[item[0]] ? ' checked' : '') + '>' +
        '<span class="swatch" style="background:' + item[2] + '"></span>' + item[1] + '</label>'
      ).join('');
    }

    function init() {
      for (const batch of DATA.batches) {
        const option = document.createElement('option');
        option.value = batch.id;
        option.textContent = '#' + batch.id + ' ' + localDateTime(batch.startTime) + ' ' + (batch.groupName || '') + ' ' + (batch.rationName || '');
        batchSelect.appendChild(option);
      }
      const preferred = DATA.batches.find((batch) => batch.id === 46) || DATA.batches[0];
      if (preferred) batchSelect.value = preferred.id;
      renderToggles();
      draw();
    }

    document.addEventListener('input', (event) => {
      const toggle = event.target?.dataset?.toggle;
      if (toggle) {
        state[toggle] = event.target.checked;
        draw();
        return;
      }
      if (event.target?.tagName === 'INPUT') draw();
    });

    batchSelect.addEventListener('change', draw);
    window.addEventListener('resize', draw);
    document.getElementById('resetBtn').addEventListener('click', () => {
      document.getElementById('minStepKg').value = 20;
      document.getElementById('minUnloadStepKg').value = 70;
      document.getElementById('stableRadius').value = 10;
      document.getElementById('stableRangeKg').value = 50;
      document.getElementById('maxTransitionSec').value = 100000;
      document.getElementById('maxUnloadTransitionSec').value = 545000;
      document.getElementById('anchorSec').value = 15;
      document.getElementById('weightScale').value = 1.048;
      document.getElementById('loadDriftMaxKg').value = 70;
      document.getElementById('loadForceKg').value = 120;
      document.getElementById('loadMovingSpeedKmh').value = 0;
      document.getElementById('loadMovingMaxPct').value = 60;
      document.getElementById('maxPlateauSec').value = 60;
      document.getElementById('loadMergeGapSec').value = 10;
      document.getElementById('stableMinPoints').value = 4;
      document.getElementById('plateauMergeGapSec').value = 0;
      document.getElementById('samePlateauKg').value = 5;
      document.getElementById('boundaryMinExtendMin').value = 3;
      document.getElementById('boundarySpeedKmh').value = 0;
      document.getElementById('bounceWindowSec').value = 0;
      document.getElementById('bounceReturnKg').value = 70;
      document.getElementById('movementDipKg').value = 80;
      document.getElementById('movementDipSpeedKmh').value = 3;
      document.getElementById('edgePlateauMinSec').value = 40;
      document.getElementById('edgePlateauMaxSec').value = 60;
      document.getElementById('edgePlateauRangeKg').value = 25;
      document.getElementById('startSoftWindowMin').value = 4;
      document.getElementById('startSoftMinLoadKg').value = 30;
      document.getElementById('startSoftPlateauMinSec').value = 20;
      document.getElementById('startSoftPlateauRangeKg').value = 30;
      document.getElementById('rawCutoffKg').value = -1000;
      document.getElementById('rawCutoffDropKg').value = 500;
      state.showRaw = false;
      state.showTelemetryWeight = false;
      state.showFiltered = true;
      state.showSpeed = true;
      state.showPlateaus = true;
      state.showEvents = true;
      state.showOldIngredients = false;
      state.excludeBounceDips = true;
      renderToggles();
      draw();
    });

    summaryTable.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-batch-id]');
      if (!row) return;
      batchSelect.value = row.dataset.batchId;
      draw();
    });

    canvas.addEventListener('mousemove', (event) => {
      const meta = canvas._chartMeta;
      if (!meta) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      state.hoverX = x;
      const ratio = (x - meta.margin.left) / Math.max(1, canvas.clientWidth - meta.margin.left - 20);
      const target = meta.minX + Math.max(0, Math.min(1, ratio)) * (meta.maxX - meta.minX);
      const points = meta.analysis.points;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length; i += 1) {
        const distance = Math.abs(points[i].x - target);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
      const point = points[bestIndex];
      const eventHit = meta.analysis.events.find((item) => point.x >= item.startMs && point.x <= item.endMs);
      const rows = [
        '<b>' + localTime(point.x) + '</b>',
        '<span style="color:' + COLORS.filtered + '">filtered: ' + kg(point.filtered) + '</span>',
        'rawWeight: ' + kg(point.raw),
        'Telemetry.weight: ' + kg(point.weight),
        'speed: ' + (Number.isFinite(point.speed) ? point.speed.toFixed(1) : '-') + ' km/h'
      ];
      if (eventHit) {
        rows.push('<hr style="border:0;border-top:1px solid rgba(255,255,255,.22)">');
        rows.push(eventTypeLabel(eventHit) + ' ' + (eventHit.delta > 0 ? '+' : '') + kg(eventHit.delta) + ' кг');
        if (eventHit.artifact) rows.push('исключено: ' + eventHit.artifactReason);
      }
      tooltip.innerHTML = rows.join('<br>');
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(window.innerWidth - 380, event.clientX + 14) + 'px';
      tooltip.style.top = Math.min(window.innerHeight - 190, event.clientY + 14) + 'px';
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
