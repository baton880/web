import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outputPath = path.resolve(__dirname, '../tmp/host-speed-filter-lab.html')
const contextMs = 10 * 60 * 1000
const defaultBatchLimit = 30

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

function parseBatchIds(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0)
}

async function loadPayload() {
  const selectedIds = parseBatchIds(process.env.SPEED_LAB_BATCH_IDS)
  const requestedLimit = Number.parseInt(process.env.SPEED_LAB_BATCH_LIMIT || '', 10)
  const take = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : defaultBatchLimit
  const batches = await prisma.batch.findMany({
    where: selectedIds.length ? { id: { in: selectedIds } } : { endTime: { not: null } },
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
    orderBy: selectedIds.length
      ? [{ startTime: 'asc' }, { id: 'asc' }]
      : [{ id: 'desc' }],
    ...(selectedIds.length ? {} : { take })
  })

  const orderedBatches = selectedIds.length ? batches : batches.slice().reverse()
  const items = []
  for (const batch of orderedBatches) {
    const startMs = new Date(batch.startTime).getTime()
    const endMs = new Date(batch.endTime || batch.startTime).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue

    const telemetry = await prisma.telemetry.findMany({
      where: {
        deviceId: batch.deviceId,
        timestamp: {
          gte: new Date(startMs - contextMs),
          lte: new Date(endMs + contextMs)
        }
      },
      select: {
        id: true,
        timestamp: true,
        weight: true,
        rawWeight: true,
        speedKmh: true,
        weightValid: true
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
      ingredients: batch.actualIngredients.map((item) => ({
        name: item.ingredientName,
        startedAt: toIso(item.startedAt || item.addedAt),
        addedAt: toIso(item.addedAt)
      })),
      telemetry: telemetry.map((row) => ({
        id: row.id,
        t: toIso(row.timestamp),
        w: round1(row.weight),
        r: round1(row.rawWeight),
        s: round1(row.speedKmh),
        weightValid: row.weightValid
      }))
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Novosibirsk',
    contextSeconds: contextMs / 1000,
    batches: items
  }
}

function buildHtml(payload) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Host speed filter lab</title>
  <style>
    :root { --bg:#f7f8fb; --panel:#fff; --ink:#172033; --muted:#667085; --line:#d8dee9; --accent:#1f6feb; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial,sans-serif; background:var(--bg); color:var(--ink); }
    header { position:sticky; top:0; z-index:2; padding:14px 18px 10px; border-bottom:1px solid var(--line); background:var(--panel); }
    h1 { margin:0 0 10px; font-size:18px; }
    .controls { display:grid; grid-template-columns:minmax(240px,1.7fr) repeat(6,minmax(115px,1fr)); gap:10px; align-items:end; }
    label { display:grid; gap:4px; color:var(--muted); font-size:12px; }
    select,input[type=number] { width:100%; padding:7px 8px; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--ink); font:inherit; }
    button { padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:#fff; cursor:pointer; color:var(--ink); }
    main { padding:14px 18px 24px; }
    .panel { margin-bottom:12px; padding:12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
    .toggles { display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; }
    .toggles label { display:inline-flex; grid-template-columns:none; align-items:center; gap:6px; color:var(--ink); font-size:13px; white-space:nowrap; }
    .swatch { display:inline-block; width:20px; height:3px; border-radius:99px; }
    #info { color:var(--muted); font-size:13px; line-height:1.45; }
    #chart { display:block; width:100%; height:640px; border:1px solid var(--line); border-radius:8px; background:#fff; cursor:crosshair; }
    #tooltip { position:fixed; z-index:5; display:none; max-width:320px; padding:8px 9px; border-radius:6px; background:rgba(23,32,51,.94); color:#fff; font-size:12px; line-height:1.35; pointer-events:none; }
    .hint { margin-top:8px; color:var(--muted); font-size:12px; }
    @media (max-width:1100px) { .controls { grid-template-columns:1fr 1fr; } #chart { height:560px; } }
  </style>
</head>
<body>
  <header>
    <h1>Host speed filter lab</h1>
    <div class="controls">
      <label>Замес <select id="batchSelect"></select></label>
      <label>Сдвиг скорости, с <input id="speedOffsetSec" type="number" min="-120" max="120" step="0.5" value="0"></label>
      <label>Hampel radius <input id="hampelRadius" type="number" min="0" max="35" step="1" value="3"></label>
      <label>Hampel sigma <input id="hampelSigma" type="number" min="0.5" max="8" step="0.1" value="3"></label>
      <label>Median radius <input id="medianRadius" type="number" min="0" max="35" step="1" value="2"></label>
      <label>Average radius <input id="averageRadius" type="number" min="0" max="35" step="1" value="0"></label>
      <label>EMA alpha <input id="emaAlpha" type="number" min="0" max="1" step="0.02" value="0"></label>
      <button id="resetBtn" type="button">Сброс</button>
    </div>
  </header>
  <main>
    <section class="panel">
      <div id="toggles" class="toggles"></div>
      <div class="hint">Сдвиг &gt; 0 рисует скорость позже исходного времени; &lt; 0 — раньше. Фильтры применяются последовательно: Hampel → median → average → EMA. Верхний график — вес host, нижний — скорость на общей временной оси.</div>
    </section>
    <section id="info" class="panel"></section>
    <canvas id="chart"></canvas>
  </main>
  <div id="tooltip"></div>
  <script>window.HOST_SPEED_FILTER_LAB_DATA = ${escapeScriptJson(payload)};</script>
  <script>
    const DATA = window.HOST_SPEED_FILTER_LAB_DATA;
    const COLORS = { weight:'#334155', raw:'#dc2626', hampel:'#f59e0b', median:'#2563eb', average:'#16a34a', ema:'#9333ea' };
    const SERIES = [ ['weight','Telemetry.weight'], ['raw','speed raw'], ['hampel','speed Hampel'], ['median','speed Hampel + median'], ['average','speed + average'], ['ema','speed + EMA'] ];
    const state = { lines:new Set(['weight','raw','median']), hoverX:null };
    const batchSelect = document.getElementById('batchSelect');
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const info = document.getElementById('info');
    const tooltip = document.getElementById('tooltip');
    const tz = 'Asia/Novosibirsk';
    const timeFormatter = new Intl.DateTimeFormat('ru-RU',{timeZone:tz,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const dateFormatter = new Intl.DateTimeFormat('ru-RU',{timeZone:tz,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    const ts = (value) => { const n = new Date(value).getTime(); return Number.isFinite(n) ? n : null; };
    const median = (values) => { const a=values.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!a.length)return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
    function rollingMedian(values,radius){ if(!(radius>0))return values.slice(); return values.map((value,index)=>median(values.slice(Math.max(0,index-radius),Math.min(values.length,index+radius+1))) ?? value); }
    function hampel(values,radius,sigma){ if(!(radius>0))return values.slice(); return values.map((value,index)=>{ if(!Number.isFinite(value))return value; const slice=values.slice(Math.max(0,index-radius),Math.min(values.length,index+radius+1)).filter(Number.isFinite); const med=median(slice); if(!Number.isFinite(med))return value; const mad=median(slice.map((item)=>Math.abs(item-med))); const threshold=sigma*1.4826*(mad||1); return Math.abs(value-med)>threshold?med:value; }); }
    function rollingAverage(values,radius){ if(!(radius>0))return values.slice(); return values.map((value,index)=>{ const slice=values.slice(Math.max(0,index-radius),Math.min(values.length,index+radius+1)).filter(Number.isFinite); return slice.length ? slice.reduce((sum,item)=>sum+item,0)/slice.length : value; }); }
    function ema(values,alpha){ if(!(alpha>0&&alpha<=1))return values.slice(); let previous=null; return values.map((value)=>{ if(!Number.isFinite(value))return null; previous=previous===null?value:alpha*value+(1-alpha)*previous; return previous; }); }
    function selectedBatch(){ return DATA.batches.find((batch)=>String(batch.id)===batchSelect.value)||DATA.batches[0]; }
    function options(){ return { offsetSec:finite(document.getElementById('speedOffsetSec').value)||0, hampelRadius:Math.max(0,Math.round(finite(document.getElementById('hampelRadius').value)||0)), hampelSigma:finite(document.getElementById('hampelSigma').value)||3, medianRadius:Math.max(0,Math.round(finite(document.getElementById('medianRadius').value)||0)), averageRadius:Math.max(0,Math.round(finite(document.getElementById('averageRadius').value)||0)), emaAlpha:finite(document.getElementById('emaAlpha').value)||0 }; }
    function buildSeries(batch){ const opts=options(); const points=batch.telemetry.map((row)=>({ x:ts(row.t), speedX:ts(row.t)+opts.offsetSec*1000, weight:finite(row.w), raw:finite(row.s), sourceTime:row.t })).filter((point)=>Number.isFinite(point.x)&&Number.isFinite(point.speedX)); const raw=points.map((point)=>point.raw); const h=hampel(raw,opts.hampelRadius,opts.hampelSigma); const m=rollingMedian(h,opts.medianRadius); const a=rollingAverage(m,opts.averageRadius); const e=ema(a,opts.emaAlpha); points.forEach((point,index)=>{ point.hampel=h[index]; point.median=m[index]; point.average=a[index]; point.ema=e[index]; }); return { points, opts }; }
    function resize(){ const rect=canvas.getBoundingClientRect(); const dpr=window.devicePixelRatio||1; canvas.width=Math.max(700,Math.floor(rect.width*dpr)); canvas.height=Math.max(480,Math.floor(rect.height*dpr)); ctx.setTransform(dpr,0,0,dpr,0,0); }
    function drawLine(points,key,xScale,yScale,color,width){ ctx.strokeStyle=color; ctx.lineWidth=width; ctx.beginPath(); let active=false; let previousX=null; for(const point of points){ const value=point[key]; const x=key==='weight'?point.x:point.speedX; if(!Number.isFinite(value)){active=false;continue;} if(previousX!==null&&x-previousX>45000)active=false; const px=xScale(x), py=yScale(value); if(!active){ctx.moveTo(px,py);active=true;}else{ctx.lineTo(px,py);} previousX=x; } ctx.stroke(); }
    function draw(){ const batch=selectedBatch(); if(!batch)return; const built=buildSeries(batch); const points=built.points; resize(); const width=canvas.clientWidth, height=canvas.clientHeight; const margin={left:58,right:20,top:24,bottom:40}; const gap=38; const plotH=Math.max(120,(height-margin.top-margin.bottom-gap)/2); const weightTop=margin.top, speedTop=margin.top+plotH+gap; const xs=[]; points.forEach((point)=>{xs.push(point.x,point.speedX);}); const minX=Math.min(...xs), maxX=Math.max(...xs); const weights=points.map((point)=>point.weight).filter(Number.isFinite); const speeds=points.flatMap((point)=>['raw','hampel','median','average','ema'].map((key)=>point[key])).filter(Number.isFinite); const maxWeight=Math.max(100,...weights.map(Math.abs)); const minWeight=Math.min(0,...weights); const weightPad=Math.max(50,(maxWeight-minWeight)*.08); const yWeight=(value)=>weightTop+(1-(value-(minWeight-weightPad))/Math.max(1,maxWeight-minWeight+weightPad*2))*plotH; const maxSpeed=Math.max(5,...speeds); const ySpeed=(value)=>speedTop+(1-Math.max(0,value)/maxSpeed)*plotH; const xScale=(value)=>margin.left+(value-minX)/Math.max(1,maxX-minX)*(width-margin.left-margin.right); ctx.clearRect(0,0,width,height); ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
      ctx.strokeStyle='#e5e7eb';ctx.lineWidth=1;ctx.fillStyle='#64748b';ctx.font='11px Arial'; for(let i=0;i<=5;i++){ const w=minWeight-weightPad+(maxWeight-minWeight+weightPad*2)*i/5; const py=yWeight(w);ctx.beginPath();ctx.moveTo(margin.left,py);ctx.lineTo(width-margin.right,py);ctx.stroke();ctx.fillText(Math.round(w)+' кг',5,py+4); const s=maxSpeed*i/5;const sy=ySpeed(s);ctx.beginPath();ctx.moveTo(margin.left,sy);ctx.lineTo(width-margin.right,sy);ctx.stroke();ctx.fillText(s.toFixed(1)+' км/ч',5,sy+4); }
      for(let i=0;i<=8;i++){ const value=minX+(maxX-minX)*i/8; const px=xScale(value);ctx.strokeStyle='#f0f2f5';ctx.beginPath();ctx.moveTo(px,weightTop);ctx.lineTo(px,speedTop+plotH);ctx.stroke();ctx.fillStyle='#64748b';ctx.fillText(timeFormatter.format(value),px-21,height-16); }
      const batchStart=xScale(ts(batch.startTime)), batchEnd=xScale(ts(batch.endTime||batch.startTime));ctx.fillStyle='rgba(37,99,235,.055)';ctx.fillRect(batchStart,weightTop,Math.max(1,batchEnd-batchStart),speedTop+plotH-weightTop);ctx.strokeStyle='rgba(37,99,235,.45)';ctx.setLineDash([5,5]);for(const x of [batchStart,batchEnd]){ctx.beginPath();ctx.moveTo(x,weightTop);ctx.lineTo(x,speedTop+plotH);ctx.stroke();}ctx.setLineDash([]);
      for(const ingredient of batch.ingredients){for(const value of [ts(ingredient.startedAt),ts(ingredient.addedAt)]){if(!Number.isFinite(value))continue;const px=xScale(value);ctx.strokeStyle='rgba(100,116,139,.35)';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(px,weightTop);ctx.lineTo(px,speedTop+plotH);ctx.stroke();ctx.setLineDash([]);}}
      for(const [key] of SERIES){if(state.lines.has(key))drawLine(points,key,xScale,key==='weight'?yWeight:ySpeed,COLORS[key],key==='raw'?1.1:2);}
      ctx.fillStyle='#334155';ctx.font='bold 12px Arial';ctx.fillText('Вес host',margin.left+4,weightTop+14);ctx.fillText('Скорость host (сдвиг '+(built.opts.offsetSec>0?'+':'')+built.opts.offsetSec+' с)',margin.left+4,speedTop+14);
      if(state.hoverX!==null){ctx.strokeStyle='#111827';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(state.hoverX,weightTop);ctx.lineTo(state.hoverX,speedTop+plotH);ctx.stroke();}
      renderInfo(batch,built); canvas._meta={minX,maxX,xScale,points,built};
    }
    function renderInfo(batch,built){ const speeds=built.points.map((point)=>point.raw).filter(Number.isFinite); const filtered=built.points.map((point)=>point.ema).filter(Number.isFinite); const rawRange=speeds.length?Math.max(...speeds)-Math.min(...speeds):null; const filteredRange=filtered.length?Math.max(...filtered)-Math.min(...filtered):null; info.innerHTML='<b>#'+batch.id+'</b> '+dateFormatter.format(new Date(batch.startTime))+' — '+dateFormatter.format(new Date(batch.endTime))+' · '+(batch.groupName||'-')+' / '+(batch.rationName||'-')+'<br>points: <b>'+built.points.length+'</b> · raw range: <b>'+(rawRange===null?'-':rawRange.toFixed(2))+' км/ч</b> · final range: <b>'+(filteredRange===null?'-':filteredRange.toFixed(2))+' км/ч</b> · offset: <b>'+(built.opts.offsetSec>0?'+':'')+built.opts.offsetSec+' с</b>'; }
    function renderToggles(){ const host=document.getElementById('toggles');host.innerHTML=SERIES.map(([key,label])=>'<label><input type="checkbox" data-line="'+key+'" '+(state.lines.has(key)?'checked':'')+'><span class="swatch" style="background:'+COLORS[key]+'"></span>'+label+'</label>').join(''); }
    function init(){ for(const batch of DATA.batches){const option=document.createElement('option');option.value=batch.id;option.textContent='#'+batch.id+' '+dateFormatter.format(new Date(batch.startTime))+' '+(batch.groupName||'');batchSelect.appendChild(option);} const preferred=DATA.batches[DATA.batches.length-1]||DATA.batches[0];if(preferred)batchSelect.value=preferred.id;renderToggles();draw(); }
    document.addEventListener('input',(event)=>{if(event.target.matches('input[type=number]'))draw();});
    document.getElementById('toggles').addEventListener('change',(event)=>{const key=event.target.dataset.line;if(!key)return;event.target.checked?state.lines.add(key):state.lines.delete(key);draw();});
    batchSelect.addEventListener('change',draw);window.addEventListener('resize',draw);
    document.getElementById('resetBtn').addEventListener('click',()=>{document.getElementById('speedOffsetSec').value=0;document.getElementById('hampelRadius').value=3;document.getElementById('hampelSigma').value=3;document.getElementById('medianRadius').value=2;document.getElementById('averageRadius').value=0;document.getElementById('emaAlpha').value=0;state.lines=new Set(['weight','raw','median']);renderToggles();draw();});
    canvas.addEventListener('mousemove',(event)=>{const meta=canvas._meta;if(!meta)return;const rect=canvas.getBoundingClientRect();const x=event.clientX-rect.left;state.hoverX=x;const ratio=(x-meta.xScale(meta.minX))/Math.max(1,meta.xScale(meta.maxX)-meta.xScale(meta.minX));const target=meta.minX+Math.max(0,Math.min(1,ratio))*(meta.maxX-meta.minX);let nearest=null,best=Infinity;for(const point of meta.points){const distance=Math.abs(point.speedX-target);if(distance<best){best=distance;nearest=point;}}if(nearest){tooltip.innerHTML='<b>speed time: '+timeFormatter.format(nearest.speedX)+'</b><br>source time: '+timeFormatter.format(nearest.x)+'<br>weight: '+(nearest.weight===null?'-':nearest.weight.toFixed(1)+' кг')+'<br>raw: '+(nearest.raw===null?'-':nearest.raw.toFixed(2))+' км/ч<br>Hampel: '+(nearest.hampel===null?'-':nearest.hampel.toFixed(2))+'<br>median: '+(nearest.median===null?'-':nearest.median.toFixed(2))+'<br>average: '+(nearest.average===null?'-':nearest.average.toFixed(2))+'<br>EMA: '+(nearest.ema===null?'-':nearest.ema.toFixed(2));tooltip.style.display='block';tooltip.style.left=Math.min(window.innerWidth-340,event.clientX+14)+'px';tooltip.style.top=Math.min(window.innerHeight-180,event.clientY+14)+'px';}draw();});
    canvas.addEventListener('mouseleave',()=>{state.hoverX=null;tooltip.style.display='none';draw();});init();
  </script>
</body>
</html>`
}

try {
  const payload = await loadPayload()
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, buildHtml(payload), 'utf8')
  console.log(`Host speed filter lab: ${outputPath}`)
  console.log(`Batches: ${payload.batches.length}`)
} finally {
  await prisma.$disconnect()
}
