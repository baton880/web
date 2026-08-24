import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { FARM_TIME_ZONE, farmDateRange, getFarmDateString } from '../src/utils/farm-date.js'

const prisma = new PrismaClient()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = path.resolve(__dirname, '../tmp/weight-filter-lab.html')
const CONTEXT_MS = 5 * 60 * 1000
const FROM_DAY = process.env.WEIGHT_LAB_FROM || '2026-08-22'
const TO_DAY = process.env.WEIGHT_LAB_TO || '2026-08-24'

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
  const fromRange = farmDateRange(FROM_DAY)
  const toRange = farmDateRange(TO_DAY)
  if (!fromRange || !toRange || fromRange.start > toRange.end) {
    throw new Error(`Invalid WEIGHT_LAB_FROM/WEIGHT_LAB_TO: ${FROM_DAY}..${TO_DAY}`)
  }

  const batches = await prisma.batch.findMany({
    where: {
      startTime: { lte: toRange.end },
      OR: [
        { endTime: { gte: fromRange.start } },
        { endTime: null }
      ]
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
      { startTime: 'asc' },
      { id: 'asc' }
    ]
  })

  const items = []
  for (const batch of batches) {
    const startMs = new Date(batch.startTime).getTime()
    const endMs = new Date(batch.endTime || toRange.end).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue

    const telemetry = await prisma.telemetry.findMany({
      where: {
        deviceId: batch.deviceId,
        timestamp: {
          gte: new Date(Math.max(fromRange.start.getTime(), startMs - CONTEXT_MS)),
          lte: new Date(Math.min(toRange.end.getTime(), endMs + CONTEXT_MS))
        }
      },
      select: {
        id: true,
        timestamp: true,
        weight: true,
        rawWeight: true,
        weightValid: true,
        speedKmh: true
      },
      orderBy: [
        { timestamp: 'asc' },
        { id: 'asc' }
      ]
    })

    items.push({
      id: batch.id,
      day: getFarmDateString(batch.startTime),
      deviceId: batch.deviceId,
      startTime: toIso(batch.startTime),
      endTime: toIso(batch.endTime),
      groupName: batch.group?.name || '',
      rationName: batch.ration?.name || '',
      startWeight: round1(batch.startWeight),
      endWeight: round1(batch.endWeight),
      ingredientSum: round1(batch.actualIngredients.reduce((sum, item) => sum + Number(item.actualWeight || 0), 0)),
      ingredients: batch.actualIngredients.map((item) => ({
        id: item.id,
        name: item.ingredientName,
        actualWeight: round1(item.actualWeight),
        startedAt: toIso(item.startedAt || item.addedAt),
        addedAt: toIso(item.addedAt)
      })),
      telemetry: telemetry.map((row) => ({
        id: row.id,
        t: toIso(row.timestamp),
        w: round1(row.weight),
        r: round1(row.rawWeight),
        valid: row.weightValid !== false,
        s: round1(row.speedKmh)
      }))
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: FARM_TIME_ZONE,
    fromDay: FROM_DAY,
    toDay: TO_DAY,
    contextMinutes: CONTEXT_MS / 60000,
    batches: items,
    defaults: {
      offline: {
        hampelRadius: 10,
        hampelSigma: 1,
        medianRadius: 8,
        averageRadius: 0,
        roundToKg: 5
      },
      realtime: {
        hampelWindow: 1,
        hampelSigma: 3,
        medianWindow: 5,
        emaAlpha: 0.3,
        fastAlpha: 0.7,
        fastStepKg: 150,
        resetGapSeconds: 12,
        roundToKg: 5
      }
    }
  }
}

function buildHtml(payload) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Weight filtration lab · 22–24 августа</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fa;
      --panel: #fff;
      --ink: #172033;
      --muted: #657187;
      --line: #d8dee8;
      --offline: #7c3aed;
      --realtime: #0f8b6d;
      --raw: #dc2626;
      --stored: #475569;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--bg); color: var(--ink); }
    header { position: sticky; top: 0; z-index: 3; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 4px; font-size: 20px; }
    .subtitle { color: var(--muted); font-size: 13px; }
    main { padding: 14px 16px 28px; }
    .panel { margin-bottom: 12px; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; }
    .top-grid { display: grid; grid-template-columns: minmax(340px, 2fr) minmax(220px, 1fr) auto; gap: 10px; align-items: end; }
    .filter-grid { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 9px; }
    .filter-grid.realtime { grid-template-columns: repeat(4, minmax(120px, 1fr)); }
    .filter-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
    .filter-title h2 { margin: 0; font-size: 16px; }
    .filter-title span { color: var(--muted); font-size: 12px; }
    label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    input, select, button, textarea { font: inherit; }
    input[type="number"], select { width: 100%; min-height: 34px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); }
    button { min-height: 34px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); cursor: pointer; }
    button:hover { border-color: #98a2b3; background: #f8fafc; }
    .toggles { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
    .toggles label { display: inline-flex; flex-direction: row; align-items: center; gap: 6px; color: var(--ink); font-size: 13px; }
    .swatch { width: 22px; height: 3px; border-radius: 99px; }
    .metrics { display: grid; grid-template-columns: repeat(5, minmax(130px, 1fr)); gap: 8px; }
    .metric { padding: 9px; border: 1px solid #e7ebf1; border-radius: 7px; background: #fafbfc; }
    .metric small { display: block; color: var(--muted); margin-bottom: 3px; }
    .metric b { font-size: 15px; }
    #batchInfo { color: var(--muted); font-size: 13px; line-height: 1.45; }
    #chart { display: block; width: 100%; height: 650px; background: #fff; border: 1px solid var(--line); border-radius: 8px; cursor: crosshair; }
    #tooltip { position: fixed; z-index: 5; display: none; max-width: 340px; padding: 8px 10px; border-radius: 6px; background: rgba(15,23,42,.94); color: #fff; pointer-events: none; font-size: 12px; line-height: 1.45; }
    .config-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: stretch; }
    textarea { width: 100%; min-height: 112px; resize: vertical; padding: 9px; border: 1px solid var(--line); border-radius: 6px; background: #0f172a; color: #dbeafe; font-family: Consolas, monospace; font-size: 12px; }
    .button-column { display: grid; gap: 8px; align-content: start; }
    .hint { margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .offline-accent { color: var(--offline); }
    .realtime-accent { color: var(--realtime); }
    @media (max-width: 1100px) {
      .top-grid, .filter-grid, .filter-grid.realtime { grid-template-columns: 1fr 1fr; }
      .metrics { grid-template-columns: 1fr 1fr; }
      #chart { height: 540px; }
    }
    @media (max-width: 650px) {
      .top-grid, .filter-grid, .filter-grid.realtime, .metrics, .config-row { grid-template-columns: 1fr; }
      main { padding: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Weight filtration lab</h1>
    <div class="subtitle">22–24 августа · offline и real-time считаются независимо от одного rawWeight</div>
  </header>
  <main>
    <section class="panel top-grid">
      <label>Замес
        <select id="batchSelect"></select>
      </label>
      <div id="batchInfo"></div>
      <button id="resetViewBtn" type="button">Сбросить масштаб</button>
    </section>

    <section class="panel">
      <div class="filter-title">
        <h2 class="offline-accent">Offline-фильтр</h2>
        <span>Некаузальный: centered-окна используют точки до и после текущей</span>
      </div>
      <div class="filter-grid">
        <label>Hampel radius, пакетов<input id="offHampelRadius" data-setting type="number" min="0" max="40" step="1"></label>
        <label>Hampel sigma<input id="offHampelSigma" data-setting type="number" min="0.1" max="10" step="0.1"></label>
        <label>Centered median radius<input id="offMedianRadius" data-setting type="number" min="0" max="40" step="1"></label>
        <label>Centered average radius<input id="offAverageRadius" data-setting type="number" min="0" max="30" step="1"></label>
        <label>Округление, кг (0 = нет)<input id="offRound" data-setting type="number" min="0" max="100" step="1"></label>
      </div>
    </section>

    <section class="panel">
      <div class="filter-title">
        <h2 class="realtime-accent">Real-time-фильтр</h2>
        <span>Строго causal: на точке N доступны только точки ≤ N</span>
      </div>
      <div class="filter-grid realtime">
        <label>Causal Hampel window<input id="rtHampelWindow" data-setting type="number" min="1" max="41" step="1"></label>
        <label>Causal Hampel sigma<input id="rtHampelSigma" data-setting type="number" min="0.1" max="10" step="0.1"></label>
        <label>Trailing median window<input id="rtMedianWindow" data-setting type="number" min="1" max="41" step="1"></label>
        <label>EMA alpha<input id="rtEmaAlpha" data-setting type="number" min="0.01" max="1" step="0.01"></label>
        <label>Fast EMA alpha<input id="rtFastAlpha" data-setting type="number" min="0.01" max="1" step="0.01"></label>
        <label>Порог быстрой ступени, кг<input id="rtFastStep" data-setting type="number" min="0" max="1000" step="5"></label>
        <label>Reset после разрыва, сек<input id="rtResetGap" data-setting type="number" min="0" max="300" step="1"></label>
        <label>Округление, кг (0 = нет)<input id="rtRound" data-setting type="number" min="0" max="100" step="1"></label>
      </div>
    </section>

    <section class="panel">
      <div class="toggles" id="toggles"></div>
      <div class="hint">Колесо мыши — масштаб по времени, двойной клик — полный диапазон. Вертикальные линии показывают сохранённые границы компонентов.</div>
    </section>
    <section class="panel metrics" id="metrics"></section>
    <canvas id="chart"></canvas>
    <section class="panel">
      <div class="filter-title"><h2>Выбранные параметры</h2><span>Скопируйте JSON и пришлите его без переписывания значений вручную</span></div>
      <div class="config-row">
        <textarea id="configOutput" readonly></textarea>
        <div class="button-column">
          <button id="copyBtn" type="button">Копировать JSON</button>
          <button id="resetFiltersBtn" type="button">Исходные настройки</button>
        </div>
      </div>
    </section>
  </main>
  <div id="tooltip"></div>

  <script>window.WEIGHT_FILTER_LAB_DATA = ${escapeScriptJson(payload)};</script>
  <script>
    const DATA = window.WEIGHT_FILTER_LAB_DATA;
    const COLORS = { raw: '#dc2626', stored: '#475569', offline: '#7c3aed', realtime: '#0f8b6d' };
    const LINE_DEFS = [
      ['raw', 'rawWeight'],
      ['stored', 'сохранённый Telemetry.weight'],
      ['offline', 'offline candidate'],
      ['realtime', 'real-time candidate']
    ];
    const state = { lines: new Set(['raw', 'stored', 'offline', 'realtime']), showIngredients: true, showSpeed: true, hoverX: null, viewStart: 0, viewEnd: 1 };
    const batchSelect = document.getElementById('batchSelect');
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const tooltip = document.getElementById('tooltip');

    function numberValue(id, fallback) { const value = Number(document.getElementById(id).value); return Number.isFinite(value) ? value : fallback; }
    function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
    function finite(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
    function ts(value) { const parsed = new Date(value).getTime(); return Number.isFinite(parsed) ? parsed : null; }
    function localTime(value) { return new Date(value).toLocaleTimeString('ru-RU', { timeZone: DATA.timezone }); }
    function localDateTime(value) { return new Date(value).toLocaleString('ru-RU', { timeZone: DATA.timezone }); }
    function roundStep(value, step) { return Number.isFinite(value) && step > 0 ? Math.round(value / step) * step : value; }

    function median(values) {
      const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
      if (!sorted.length) return null;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function centeredMedian(values, radius) {
      radius = Math.max(0, Math.round(radius));
      if (!radius) return values.slice();
      return values.map((value, index) => median(values.slice(Math.max(0, index - radius), index + radius + 1)) ?? value);
    }

    function centeredAverage(values, radius) {
      radius = Math.max(0, Math.round(radius));
      if (!radius) return values.slice();
      return values.map((value, index) => {
        const slice = values.slice(Math.max(0, index - radius), index + radius + 1).filter(Number.isFinite);
        return slice.length ? slice.reduce((sum, item) => sum + item, 0) / slice.length : value;
      });
    }

    function centeredHampel(values, radius, sigma) {
      radius = Math.max(0, Math.round(radius));
      if (!radius) return values.slice();
      return values.map((value, index) => {
        if (!Number.isFinite(value)) return value;
        const slice = values.slice(Math.max(0, index - radius), index + radius + 1).filter(Number.isFinite);
        const med = median(slice);
        if (!Number.isFinite(med)) return value;
        const mad = median(slice.map((item) => Math.abs(item - med)));
        const threshold = Math.max(0.001, sigma * 1.4826 * (mad || 1));
        return Math.abs(value - med) > threshold ? med : value;
      });
    }

    function causalHampel(history, value, windowSize, sigma) {
      windowSize = Math.max(1, Math.round(windowSize));
      if (windowSize <= 1) return value;
      const slice = history.slice(Math.max(0, history.length - windowSize + 1)).concat(value).filter(Number.isFinite);
      const med = median(slice);
      if (!Number.isFinite(med)) return value;
      const mad = median(slice.map((item) => Math.abs(item - med)));
      const threshold = Math.max(0.001, sigma * 1.4826 * (mad || 1));
      return Math.abs(value - med) > threshold ? med : value;
    }

    function settings() {
      return {
        offline: {
          source: 'rawWeight', causal: false,
          hampelRadius: Math.max(0, Math.round(numberValue('offHampelRadius', 0))),
          hampelSigma: Math.max(0.1, numberValue('offHampelSigma', 1)),
          medianRadius: Math.max(0, Math.round(numberValue('offMedianRadius', 0))),
          averageRadius: Math.max(0, Math.round(numberValue('offAverageRadius', 0))),
          roundToKg: Math.max(0, numberValue('offRound', 0))
        },
        realtime: {
          source: 'rawWeight', causal: true,
          hampelWindow: Math.max(1, Math.round(numberValue('rtHampelWindow', 1))),
          hampelSigma: Math.max(0.1, numberValue('rtHampelSigma', 3)),
          medianWindow: Math.max(1, Math.round(numberValue('rtMedianWindow', 1))),
          emaAlpha: clamp(numberValue('rtEmaAlpha', 1), 0.01, 1),
          fastAlpha: clamp(numberValue('rtFastAlpha', 1), 0.01, 1),
          fastStepKg: Math.max(0, numberValue('rtFastStep', 0)),
          resetGapSeconds: Math.max(0, numberValue('rtResetGap', 0)),
          roundToKg: Math.max(0, numberValue('rtRound', 0))
        }
      };
    }

    function selectedBatch() { return DATA.batches.find((batch) => String(batch.id) === batchSelect.value) || DATA.batches[0]; }

    function buildSeries(batch) {
      const cfg = settings();
      const points = batch.telemetry.map((row) => ({
        x: ts(row.t), raw: finite(row.r) ?? finite(row.w), stored: finite(row.w), valid: row.valid !== false, speed: finite(row.s)
      })).filter((point) => Number.isFinite(point.x));
      const raw = points.map((point) => point.raw);
      const offline = centeredAverage(
        centeredMedian(centeredHampel(raw, cfg.offline.hampelRadius, cfg.offline.hampelSigma), cfg.offline.medianRadius),
        cfg.offline.averageRadius
      ).map((value) => roundStep(value, cfg.offline.roundToKg));

      const realtime = [];
      let rawHistory = [];
      let causalHistory = [];
      let ema = null;
      let previousTime = null;
      for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        const gapSeconds = previousTime == null ? 0 : (point.x - previousTime) / 1000;
        if (!point.valid || !Number.isFinite(point.raw)) {
          rawHistory = []; causalHistory = []; ema = null; realtime.push(null); previousTime = point.x; continue;
        }
        if (cfg.realtime.resetGapSeconds > 0 && gapSeconds > cfg.realtime.resetGapSeconds) {
          rawHistory = []; causalHistory = []; ema = null;
        }
        const cleaned = causalHampel(rawHistory, point.raw, cfg.realtime.hampelWindow, cfg.realtime.hampelSigma);
        rawHistory.push(point.raw); if (rawHistory.length > 100) rawHistory.shift();
        causalHistory.push(cleaned); if (causalHistory.length > 100) causalHistory.shift();
        const trailing = median(causalHistory.slice(-cfg.realtime.medianWindow)) ?? cleaned;
        if (!Number.isFinite(ema)) ema = trailing;
        else {
          const delta = Math.abs(trailing - ema);
          const alpha = cfg.realtime.fastStepKg > 0 && delta >= cfg.realtime.fastStepKg ? cfg.realtime.fastAlpha : cfg.realtime.emaAlpha;
          ema += alpha * (trailing - ema);
        }
        realtime.push(roundStep(ema, cfg.realtime.roundToKg));
        previousTime = point.x;
      }
      return { cfg, points, lines: { raw, stored: points.map((point) => point.stored), offline, realtime }, speed: points.map((point) => point.speed) };
    }

    function percentile(values, fraction) {
      const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
      if (!sorted.length) return null;
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
    }

    function deltaStats(values) {
      const deltas = [];
      for (let i = 1; i < values.length; i += 1) if (Number.isFinite(values[i]) && Number.isFinite(values[i - 1])) deltas.push(Math.abs(values[i] - values[i - 1]));
      return { median: percentile(deltas, 0.5), p95: percentile(deltas, 0.95) };
    }

    function renderMetrics(built) {
      const rawStats = deltaStats(built.lines.raw);
      const offlineStats = deltaStats(built.lines.offline);
      const realtimeStats = deltaStats(built.lines.realtime);
      const gaps = [];
      for (let i = 1; i < built.points.length; i += 1) gaps.push((built.points[i].x - built.points[i - 1].x) / 1000);
      const samplePeriod = percentile(gaps.filter((value) => value > 0 && value < 30), 0.5);
      const offWidth = built.cfg.offline.medianRadius * 2 + 1;
      const offFuture = built.cfg.offline.medianRadius + built.cfg.offline.averageRadius;
      document.getElementById('metrics').innerHTML = [
        ['Период пакета', samplePeriod == null ? '—' : samplePeriod.toFixed(1) + ' сек'],
        ['Raw Δ p95', rawStats.p95 == null ? '—' : Math.round(rawStats.p95) + ' кг'],
        ['Offline Δ p95', offlineStats.p95 == null ? '—' : Math.round(offlineStats.p95) + ' кг'],
        ['Real-time Δ p95', realtimeStats.p95 == null ? '—' : Math.round(realtimeStats.p95) + ' кг'],
        ['Offline окно/будущее', offWidth + ' пак. / +' + offFuture + ' пак.']
      ].map((item) => '<div class="metric"><small>' + item[0] + '</small><b>' + item[1] + '</b></div>').join('');
    }

    function renderConfig(built) {
      const output = { data: { from: DATA.fromDay, to: DATA.toDay, batchId: selectedBatch()?.id ?? null }, offline: built.cfg.offline, realtime: built.cfg.realtime };
      document.getElementById('configOutput').value = JSON.stringify(output, null, 2);
      try { localStorage.setItem('weight-filter-lab-settings', JSON.stringify(built.cfg)); } catch {}
    }

    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(600, Math.floor(rect.width * dpr)); canvas.height = Math.max(420, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      const batch = selectedBatch(); if (!batch) return;
      const built = buildSeries(batch); resizeCanvas();
      const width = canvas.clientWidth; const height = canvas.clientHeight;
      const margin = { left: 62, right: 20, top: 24, bottom: state.showSpeed ? 112 : 50 };
      const plotW = width - margin.left - margin.right; const plotH = height - margin.top - margin.bottom;
      const fullMinX = built.points[0]?.x ?? 0; const fullMaxX = built.points[built.points.length - 1]?.x ?? fullMinX + 1;
      const fullSpan = Math.max(1, fullMaxX - fullMinX);
      const minX = fullMinX + fullSpan * state.viewStart; const maxX = fullMinX + fullSpan * state.viewEnd;
      const visibleIndexes = [];
      for (let i = 0; i < built.points.length; i += 1) if (built.points[i].x >= minX && built.points[i].x <= maxX) visibleIndexes.push(i);
      const activeValues = [];
      for (const key of state.lines) for (const index of visibleIndexes) { const value = built.lines[key]?.[index]; if (Number.isFinite(value)) activeValues.push(value); }
      const minYRaw = activeValues.length ? Math.min(...activeValues) : 0; const maxYRaw = activeValues.length ? Math.max(...activeValues) : 1000;
      const padY = Math.max(50, (maxYRaw - minYRaw) * 0.08);
      const minY = Math.floor((minYRaw - padY) / 50) * 50; const maxY = Math.ceil((maxYRaw + padY) / 50) * 50;
      const xScale = (x) => margin.left + (x - minX) / Math.max(1, maxX - minX) * plotW;
      const yScale = (y) => margin.top + (1 - (y - minY) / Math.max(1, maxY - minY)) * plotH;
      ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1; ctx.fillStyle = '#64748b'; ctx.font = '12px Arial';
      for (let i = 0; i <= 6; i += 1) {
        const y = minY + (maxY - minY) * i / 6; const py = yScale(y);
        ctx.beginPath(); ctx.moveTo(margin.left, py); ctx.lineTo(width - margin.right, py); ctx.stroke(); ctx.fillText(String(Math.round(y)), 8, py + 4);
      }
      for (let i = 0; i <= 8; i += 1) {
        const x = minX + (maxX - minX) * i / 8; const px = xScale(x);
        ctx.beginPath(); ctx.moveTo(px, margin.top); ctx.lineTo(px, margin.top + plotH); ctx.stroke(); ctx.fillText(localTime(x), px - 25, margin.top + plotH + 20);
      }
      const batchStartX = xScale(ts(batch.startTime)); const batchEndX = xScale(ts(batch.endTime || batch.startTime));
      ctx.fillStyle = 'rgba(31,111,235,.05)'; ctx.fillRect(batchStartX, margin.top, Math.max(1, batchEndX - batchStartX), plotH);
      ctx.save(); ctx.beginPath(); ctx.rect(margin.left, margin.top, plotW, plotH); ctx.clip();
      if (state.showIngredients) {
        const names = [...new Set(batch.ingredients.map((item) => item.name))];
        const palette = ['#dc2626','#2563eb','#16a34a','#9333ea','#ea580c','#0891b2','#be123c'];
        for (const ingredient of batch.ingredients) {
          const index = Math.max(0, names.indexOf(ingredient.name)); const sx = xScale(ts(ingredient.startedAt)); const ex = xScale(ts(ingredient.addedAt));
          ctx.strokeStyle = palette[index % palette.length]; ctx.lineWidth = 1; ctx.setLineDash([4,5]);
          ctx.beginPath(); ctx.moveTo(sx, margin.top); ctx.lineTo(sx, margin.top + plotH); ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(ex, margin.top); ctx.lineTo(ex, margin.top + plotH); ctx.stroke();
          if (ex >= margin.left && ex <= width - margin.right) { ctx.fillStyle = palette[index % palette.length]; ctx.font = '11px Arial'; ctx.fillText(ingredient.name + ' ' + Math.round(ingredient.actualWeight || 0), ex + 3, margin.top + 13 + (index % 8) * 14); }
        }
      }
      for (const [key] of LINE_DEFS) {
        if (!state.lines.has(key)) continue;
        ctx.strokeStyle = COLORS[key]; ctx.lineWidth = key === 'offline' || key === 'realtime' ? 2.2 : 1.1; ctx.beginPath(); let started = false;
        for (let i = 0; i < built.points.length; i += 1) {
          const x = built.points[i].x; const value = built.lines[key][i];
          if (x < minX || x > maxX || !Number.isFinite(value)) { started = false; continue; }
          const px = xScale(x); const py = yScale(value); if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
      }
      ctx.restore();
      if (state.showSpeed) {
        const speedTop = height - 78; const speedH = 42;
        const visibleSpeeds = visibleIndexes.map((i) => built.speed[i]).filter(Number.isFinite); const maxSpeed = Math.max(5, Math.ceil(Math.max(...visibleSpeeds, 0)));
        const ySpeed = (value) => speedTop + speedH - Math.max(0, value) / maxSpeed * speedH;
        ctx.strokeStyle = '#e5e7eb'; ctx.strokeRect(margin.left, speedTop, plotW, speedH); ctx.strokeStyle = '#94a3b8'; ctx.beginPath(); let started = false;
        for (const index of visibleIndexes) { const value = built.speed[index]; if (!Number.isFinite(value)) { started = false; continue; } const px = xScale(built.points[index].x); const py = ySpeed(value); if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; } }
        ctx.stroke(); ctx.fillStyle = '#64748b'; ctx.fillText('speed 0..' + maxSpeed + ' km/h', margin.left + 4, speedTop - 6);
      }
      if (state.hoverX != null) { ctx.strokeStyle = '#111827'; ctx.beginPath(); ctx.moveTo(state.hoverX, margin.top); ctx.lineTo(state.hoverX, margin.top + plotH); ctx.stroke(); }
      const avgGap = built.points.length > 1 ? (built.points[built.points.length - 1].x - built.points[0].x) / (built.points.length - 1) / 1000 : 0;
      document.getElementById('batchInfo').innerHTML = '<b>#' + batch.id + '</b> · ' + batch.day + '<br>' + (batch.groupName || '—') + ' / ' + (batch.rationName || '—') + ' · ' + batch.telemetry.length + ' пак. · ≈' + avgGap.toFixed(1) + ' сек';
      renderMetrics(built); renderConfig(built); canvas._meta = { built, minX, maxX, margin, plotW, plotH };
    }

    function renderToggles() {
      const container = document.getElementById('toggles'); container.innerHTML = '';
      for (const [key, label] of LINE_DEFS) {
        const item = document.createElement('label'); item.innerHTML = '<input type="checkbox" data-line="' + key + '" ' + (state.lines.has(key) ? 'checked' : '') + '><span class="swatch" style="background:' + COLORS[key] + '"></span>' + label; container.appendChild(item);
      }
      for (const [key, label] of [['showIngredients','границы компонентов'],['showSpeed','скорость']]) {
        const item = document.createElement('label'); item.innerHTML = '<input type="checkbox" data-extra="' + key + '" ' + (state[key] ? 'checked' : '') + '>' + label; container.appendChild(item);
      }
    }

    function applyDefaults() {
      const off = DATA.defaults.offline; const rt = DATA.defaults.realtime;
      const values = {
        offHampelRadius: off.hampelRadius, offHampelSigma: off.hampelSigma, offMedianRadius: off.medianRadius, offAverageRadius: off.averageRadius, offRound: off.roundToKg,
        rtHampelWindow: rt.hampelWindow, rtHampelSigma: rt.hampelSigma, rtMedianWindow: rt.medianWindow, rtEmaAlpha: rt.emaAlpha, rtFastAlpha: rt.fastAlpha,
        rtFastStep: rt.fastStepKg, rtResetGap: rt.resetGapSeconds, rtRound: rt.roundToKg
      };
      for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
    }

    function tryRestoreSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('weight-filter-lab-settings') || 'null'); if (!saved?.offline || !saved?.realtime) return false;
        const values = {
          offHampelRadius: saved.offline.hampelRadius, offHampelSigma: saved.offline.hampelSigma, offMedianRadius: saved.offline.medianRadius,
          offAverageRadius: saved.offline.averageRadius, offRound: saved.offline.roundToKg, rtHampelWindow: saved.realtime.hampelWindow,
          rtHampelSigma: saved.realtime.hampelSigma, rtMedianWindow: saved.realtime.medianWindow, rtEmaAlpha: saved.realtime.emaAlpha,
          rtFastAlpha: saved.realtime.fastAlpha, rtFastStep: saved.realtime.fastStepKg, rtResetGap: saved.realtime.resetGapSeconds, rtRound: saved.realtime.roundToKg
        };
        for (const [id, value] of Object.entries(values)) if (value != null) document.getElementById(id).value = value; return true;
      } catch { return false; }
    }

    function resetView() { state.viewStart = 0; state.viewEnd = 1; draw(); }
    function init() {
      let currentGroup = null; let group = null;
      for (const batch of DATA.batches) {
        if (batch.day !== currentGroup) { currentGroup = batch.day; group = document.createElement('optgroup'); group.label = currentGroup; batchSelect.appendChild(group); }
        const option = document.createElement('option'); option.value = batch.id; option.textContent = '#' + batch.id + ' ' + localTime(batch.startTime) + ' · ' + (batch.groupName || '') + ' · ' + (batch.rationName || ''); group.appendChild(option);
      }
      applyDefaults(); tryRestoreSettings(); renderToggles(); draw();
    }

    document.addEventListener('input', (event) => {
      const line = event.target?.dataset?.line; const extra = event.target?.dataset?.extra;
      if (line) { if (event.target.checked) state.lines.add(line); else state.lines.delete(line); }
      if (extra) state[extra] = event.target.checked;
      if (event.target.matches('[data-setting]') || line || extra) draw();
    });
    batchSelect.addEventListener('change', resetView);
    document.getElementById('resetViewBtn').addEventListener('click', resetView);
    document.getElementById('resetFiltersBtn').addEventListener('click', () => { applyDefaults(); draw(); });
    document.getElementById('copyBtn').addEventListener('click', async () => {
      const button = document.getElementById('copyBtn');
      try { await navigator.clipboard.writeText(document.getElementById('configOutput').value); button.textContent = 'Скопировано'; }
      catch { document.getElementById('configOutput').select(); document.execCommand('copy'); button.textContent = 'Скопировано'; }
      setTimeout(() => { button.textContent = 'Копировать JSON'; }, 1200);
    });
    window.addEventListener('resize', draw); canvas.addEventListener('dblclick', resetView);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault(); const rect = canvas.getBoundingClientRect(); const ratio = clamp((event.clientX - rect.left - 62) / Math.max(1, canvas.clientWidth - 82), 0, 1);
      const span = state.viewEnd - state.viewStart; const nextSpan = clamp(span * (event.deltaY > 0 ? 1.25 : 0.8), 0.03, 1); const anchor = state.viewStart + span * ratio;
      state.viewStart = clamp(anchor - nextSpan * ratio, 0, 1 - nextSpan); state.viewEnd = state.viewStart + nextSpan; draw();
    }, { passive: false });
    canvas.addEventListener('mousemove', (event) => {
      const meta = canvas._meta; if (!meta) return; const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; state.hoverX = x;
      const ratio = clamp((x - meta.margin.left) / Math.max(1, meta.plotW), 0, 1); const target = meta.minX + ratio * (meta.maxX - meta.minX);
      let best = 0; let distance = Infinity;
      for (let i = 0; i < meta.built.points.length; i += 1) { const current = Math.abs(meta.built.points[i].x - target); if (current < distance) { distance = current; best = i; } }
      const rows = ['<b>' + localTime(meta.built.points[best].x) + '</b>'];
      for (const [key, label] of LINE_DEFS) { const value = meta.built.lines[key][best]; rows.push('<span style="color:' + COLORS[key] + '">' + label + ': ' + (Number.isFinite(value) ? Math.round(value) + ' кг' : '—') + '</span>'); }
      rows.push('speed: ' + (Number.isFinite(meta.built.speed[best]) ? meta.built.speed[best] + ' km/h' : '—'));
      tooltip.innerHTML = rows.join('<br>'); tooltip.style.display = 'block'; tooltip.style.left = Math.min(window.innerWidth - 350, event.clientX + 14) + 'px'; tooltip.style.top = Math.min(window.innerHeight - 190, event.clientY + 14) + 'px'; draw();
    });
    canvas.addEventListener('mouseleave', () => { state.hoverX = null; tooltip.style.display = 'none'; draw(); });
    init();
  </script>
</body>
</html>`
}

try {
  const payload = await loadPayload()
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await fs.writeFile(OUTPUT_PATH, buildHtml(payload), 'utf8')
  console.log(JSON.stringify({ output: OUTPUT_PATH, fromDay: FROM_DAY, toDay: TO_DAY, batches: payload.batches.length }))
} finally {
  await prisma.$disconnect()
}
