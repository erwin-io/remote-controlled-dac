// Polls /api/logs and renders:
// - Gauge = last 5-sec average improvement (g5)
// - Chart = 5-sec averages (Ambient/Filtered) (g5)
// - Table = 1-min averages (m1)
//
// Leak-free: setTimeout scheduled after each fetch; backs off when hidden/errors.
// Matches server response shape: { g5: [...], m1: [...] }

const RAW_WINDOW_MS = 5 * 60 * 1000;   // chart window

// state (recomputed each poll; no unbounded growth)
let five = [];    // [{t, tsText, amb, fil, imp}]
let minutes = []; // [{t, tsText, amb, fil, imp}]

let pollDelay = 1000;
let failStreak = 0;
let stopPolling = false;

document.addEventListener("visibilitychange", () => {
  pollDelay = document.hidden ? 3000 : 1000;
});

// ---------- helpers ----------
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const getCssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function timeHMS(ms){
  const d=new Date(ms||0);
  const h=String(d.getHours()).padStart(2,"0");
  const m=String(d.getMinutes()).padStart(2,"0");
  const s=String(d.getSeconds()).padStart(2,"0");
  return `${h}:${m}:${s}`;
}

// ---------- mapping ----------
function mapFromServer(json){
  // Map g5
  five = Array.isArray(json?.g5) ? json.g5.map(b => ({
    t: (Number(b.epoch)||0)*1000,
    tsText: typeof b.timestamp === "string" ? b.timestamp : "",
    amb: Number(b.ambient),
    fil: Number(b.filtered),
    imp: Number(b.improvement)
  })) : [];

  // Keep only last RAW_WINDOW_MS for chart
  if (five.length){
    const now = five[five.length-1].t;
    const cutoff = now - RAW_WINDOW_MS;
    five = five.filter(p => p.t >= cutoff);
  }

  // Map m1 for table
  minutes = Array.isArray(json?.m1) ? json.m1.map(b => ({
    t: (Number(b.epoch)||0)*1000,
    tsText: typeof b.timestamp === "string" ? b.timestamp : "",
    amb: Number(b.ambient),
    fil: Number(b.filtered),
    imp: Number(b.improvement)
  })) : [];
}

// ---------- rendering ----------
function renderGauge(){
  const gauge = document.querySelector("#gauge");
  const label = document.querySelector("#gauge-label");
  if (!gauge || !label) return;

  if (!five.length) { gauge.style.setProperty("--p","0%"); label.textContent="--%"; return; }
  const last = five[five.length-1];
  const pct = Math.max(0, Math.min(100, last.imp));
  gauge.style.setProperty("--p", `${pct}%`);
  label.textContent = `${last.imp.toFixed(1)}%`;
}

function renderTable(){
  const tbody = document.querySelector("#log-table tbody");
  if (!tbody) return;

  const rows = minutes.slice().reverse(); // newest first
  let html = "";
  for (const r of rows) {
    const delta = r.amb - r.fil;
    html += `<tr>
      <td>${r.tsText || ""}</td>
      <td>${Number.isFinite(r.amb)?r.amb.toFixed(1):"--"}</td>
      <td>${Number.isFinite(r.fil)?r.fil.toFixed(1):"--"}</td>
      <td>${Number.isFinite(delta)?delta.toFixed(1):"--"}</td>
      <td>${Number.isFinite(r.imp)?r.imp.toFixed(1):"--"}%</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

function renderChart(){
  const canvas = document.querySelector("#ppm-chart");
  if (!canvas) return;

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 220;
  const w = Math.floor(cssW*dpr), h = Math.floor(cssH*dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  const padL=46, padR=8, padT=10, padB=22;
  const plotW = cssW - padL - padR, plotH = cssH - padT - padB;

  // grid 0..1000
  ctx.save();
  ctx.strokeStyle = "#1e293b"; ctx.lineWidth = 1;
  ctx.fillStyle = "#94a3b8"; ctx.font = "12px system-ui";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let i=0;i<=10;i++){
    const frac = i/10;
    const y = padT + (1 - frac) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, Math.round(y)+0.5); ctx.lineTo(padL+plotW, Math.round(y)+0.5); ctx.stroke();
    ctx.fillText(`${i*100} ppm`, 6, y);
  }
  ctx.restore();

  if (!five.length) {
    drawLabel(ctx, cssW, cssH, "Waiting for data…");
    return;
  }

  const now = five[five.length-1].t;
  const cutoff = now - RAW_WINDOW_MS;
  const view = five.filter(p => p.t >= cutoff);
  const t0 = Math.min(cutoff, view[0].t), t1 = Math.max(now, view[view.length-1].t);
  const span = Math.max(1000, t1 - t0);
  const x = (t)=> padL + ((t - t0) / span) * plotW;
  const y = (val)=> padT + (1 - clamp01((Number(val)||0) / 1000)) * plotH;

  drawLine(ctx, view.map(p=>[x(p.t), y(p.amb)]), getCssVar("--amb"));
  drawLine(ctx, view.map(p=>[x(p.t), y(p.fil)]), getCssVar("--fil"));

  // X labels
  ctx.fillStyle = "#94a3b8"; ctx.font = "12px system-ui";
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const first = view[0], mid = view[Math.floor((view.length-1)/2)], last = view[view.length-1];
  ctx.fillText(first?.tsText || timeHMS(first?.t || t0), padL, cssH - 16);
  ctx.fillText(mid?.tsText   || timeHMS(mid?.t   || (t0+t1)/2), padL + plotW/2, cssH - 16);
  ctx.fillText(last?.tsText  || timeHMS(last?.t  || t1), padL + plotW, cssH - 16);
}

function drawLine(ctx, pts, color){
  if (pts.length < 2) return;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke(); ctx.restore();
}
function drawLabel(ctx, w, h, text){
  ctx.fillStyle = "#94a3b8"; ctx.font = "14px system-ui";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, w/2, h/2);
}

// ---------- polling ----------
async function pollOnce(){
  if (stopPolling) return;
  try {
    const r = await fetch("/api/logs?g5=120&m1=180", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    mapFromServer(j);
    renderGauge(); renderChart(); renderTable();
    failStreak = 0;
  } catch {
    failStreak++;
  } finally {
    const backoff = Math.min(10000, pollDelay * Math.max(1, failStreak));
    setTimeout(pollOnce, backoff);
  }
}

// ---------- export ----------
function exportExcel(){ location.href = "/export.xlsx"; }
window.exportExcel = exportExcel;

// start
pollOnce();
window.addEventListener("beforeunload", () => { stopPolling = true; });
