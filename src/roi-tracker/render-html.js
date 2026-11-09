#!/usr/bin/env node
/**
 * HTML renderer — one of the interchangeable frontends over the canonical
 * pipeline JSON. Inlines the data so the output is a single self-contained
 * file openable via file:// (no server, no build).
 *
 * Usage: node src/render-html.js   # reads data/roi-output.json (or runs the
 *                                  # pipeline if missing) -> docs/roi-dashboard.html
 */
const fs = require('fs');
const path = require('path');

const { agentqHome, homeDataPath } = require('../lib/home.js');

function getData() {
  const p = homeDataPath('roi-output.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  // run() alone doesn't attach `trend` (only pipeline.js's own main() does,
  // via snapshotAndTrend) — do the same here so a direct render-html.js
  // invocation without a prior pipeline run still gets the trend chart and
  // still writes today's snapshot, instead of silently doing neither.
  const pipeline = require('./pipeline.js');
  const out = pipeline.run();
  out.trend = pipeline.snapshotAndTrend(out);
  return out;
}

const fmt = (v, d = 3) => v == null ? '—' : (typeof v === 'number' ? v.toFixed(d) : String(v));
const usd = v => v == null || v === '' ? '—' : (typeof v === 'number' ? '$' + v.toFixed(2) : String(v));

function page(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sub ROI — Model & Path Dashboard</title>
<style>
  :root { --bg:#0f1117; --panel:#171a23; --line:#2a2f3a; --fg:#e6e8ee; --mut:#8b93a7;
          --good:#3ddc97; --warn:#ffb454; --bad:#ff5d6c; --accent:#6ea8fe; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:16px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; }
  .gen { color:var(--mut); font-size:12px; }
  .wrap { padding:20px 24px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); margin:24px 0 10px; }
  table { border-collapse:collapse; width:100%; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th,td { padding:7px 10px; text-align:right; border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child,td:first-child { text-align:left; }
  th { color:var(--mut); font-weight:600; cursor:pointer; user-select:none; position:sticky; top:0; background:var(--panel); }
  th.sorted::after { content:" ▾"; color:var(--accent); }
  tr:hover td { background:#1d212c; }
  .tier-Frontier { color:var(--good); font-weight:600; }
  .tier-High { color:var(--accent); }
  .tier-Mid { color:var(--warn); }
  .tier-Low { color:var(--mut); }
  .st-under { color:var(--bad); font-weight:600; }
  .st-pay { color:var(--good); }
  .st-other { color:var(--mut); }
  .toggle { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .toggle button { background:var(--panel); color:var(--mut); border:0; padding:5px 14px; cursor:pointer; font:inherit; }
  .toggle button.on { background:var(--accent); color:#0b0d12; font-weight:600; }
  .mut { color:var(--mut); }
  .stale { color:var(--warn); font-weight:600; }
  .spend { color:var(--good); }
  .verdict { padding:2px 9px; border-radius:4px; font-weight:700; font-size:11px; letter-spacing:.04em; }
  .expando { cursor:pointer; user-select:none; font-size:12px; width:24px; padding:0 4px; text-align:center; color:var(--mut); }
  .expando.open { color:var(--accent); }
  .detail-row { display:none; background:rgba(110,168,254,.04); }
  .detail-row.open { display:table-row; }
  .detail-row td { padding:4px 10px 12px 34px; }
  .detail-table { width:100%; border-collapse:collapse; font-size:12px; }
  .detail-table th { color:var(--mut); font-weight:600; font-size:11px; text-align:right; padding:3px 8px; border:none; background:transparent; cursor:default; }
  .detail-table th:first-child { text-align:left; }
  .detail-table td { padding:2px 8px; text-align:right; border:none; }
  .detail-table td:first-child { text-align:left; }
  .detail-table tr:hover td { background:rgba(110,168,254,.06); }
  .bch-inp { width:48px; background:var(--bg); border:1px solid var(--line); border-radius:3px; color:var(--fg); padding:2px 4px; font:12px monospace; text-align:right; }
  .bch-inp:focus { border-color:var(--accent); outline:none; }
  .bch-save { background:var(--accent); color:#0b0d12; border:0; border-radius:4px; padding:3px 10px; font-weight:600; cursor:pointer; font-size:11px; }
  .bch-save:disabled { opacity:.4; cursor:default; }
  .bch-save:hover:not(:disabled) { filter:brightness(1.15); }
  .v-keep { background:rgba(61,220,151,.18); color:var(--good); }
  .v-review { background:rgba(255,180,84,.18); color:var(--warn); }
  .v-cancel { background:rgba(255,93,108,.18); color:var(--bad); }
  .v-no-data { background:#222; color:var(--mut); }
  .rollup-totals { font-size:15px; margin:8px 2px 2px; }
  .bar { display:inline-block; height:8px; background:var(--accent); border-radius:2px; vertical-align:middle; }
  .scatter { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
  .scatter text { fill:var(--mut); font:11px system-ui,sans-serif; }
  .scatter .dot { fill:var(--accent); cursor:pointer; }
  .scatter .lbl { fill:var(--fg); font-size:10px; }
  .scatter .axis { stroke:var(--line); }
  .alert { margin:16px 24px 0; padding:10px 14px; border:1px solid var(--bad); border-radius:8px;
           background:rgba(255,93,108,.08); color:var(--fg); font-size:13px; }
  .alert b { color:var(--bad); }
  .trend .line { fill:none; stroke:var(--good); stroke-width:2; }
  .trend .dot { fill:var(--good); }
  .trend .dot.stale { fill:var(--mut); opacity:.6; }
</style></head>
<body>
<header>
  <h1>Sub ROI Dashboard</h1>
  <div class="toggle" id="profile">
    <button data-p="Tax" class="on">Professional</button>
    <button data-p="Hobby">Hobbyist</button>
  </div>
  <span class="gen">generated <span id="gen"></span> · <span id="pricegen" class="mut"></span> · <span id="cov"></span></span>
</header>
<div id="alertBox"></div>
<div class="wrap">
  <h2>Subscriptions — keep or cancel? <span class="mut" id="rollupWindow"></span></h2>
  <table id="rollup"><thead><tr>
    <th style="width:24px"></th><th>Subscription</th><th>Fee/mo</th><th>Value/mo</th><th title="Historical measured list-value per monthly fee">ROI</th><th title="Quota-window usage projected to a monthly equivalent, divided by the monthly fee">Quota ROI</th>
    <th title="Capacity used: rate-limit quota (codexbar, counts cloud) for flat-rate subs, or $allowance utilization for wallets">Used</th><th>Verdict</th>
  </tr></thead><tbody></tbody></table>
  <p class="rollup-totals" id="rollupTotals"></p>
  <p class="mut">Value/mo = measured list-value normalized to a month — a <b>floor</b> (misses cloud/web sessions). ROI is historical measured value ÷ fee; Quota ROI projects the selected quota window to a monthly equivalent. <span class="v-review verdict">REVIEW</span> = heavily used but measured $ is under the fee — likely still worth it once cloud usage counts.</p>

  <h2>Access paths — economics</h2>
  <table id="paths"><thead><tr>
    <th>Path</th><th>Type</th><th>Fee/mo</th><th>Value run</th><th>Covered</th>
    <th>Util</th><th>Eff. mult</th><th>ROI</th><th title="App-reported rate-limit window usage (codexbar)">Quota used</th><th>Status</th>
  </tr></thead><tbody></tbody></table>

  <h2>Models — intelligence, token-for-money &amp; what you spent <span class="mut" id="profLabel"></span></h2>
  <table id="models"><thead><tr>
    <th data-k="model">Model</th>
    <th data-k="cap" class="sorted">Intelligence</th>
    <th data-k="val">Value</th>
    <th data-k="tier">Tier</th>
    <th data-k="list" title="Live list price, blended $/Mtok — cheapest of OpenRouter / OpenCode. Hover a cell for all sources.">List $/Mtok</th>
    <th data-k="minCost" title="Your effective $/Mtok via the cheapest access path you have">Your $/Mtok</th>
    <th data-k="bestPath">Cheapest via</th>
    <th data-k="spent" title="What you actually spent on this model this period (ccusage)">Spent</th>
    <th data-k="tokens" title="Total tokens used this period">Tokens</th>
    <th data-k="speed">Speed</th>
  </tr></thead><tbody></tbody></table>
  <p class="mut">Intelligence = profile-weighted benchmark capability (cost-blind). Value = intelligence − λ·cost. List $/Mtok is <b>live</b> (OpenRouter/OpenCode); <span class="stale">orange</span> = your xlsx price is stale vs live. Your $/Mtok reflects your path Eff. mults.</p>

  <div id="trendSection" style="display:none">
    <h2>Spend over time <span class="mut" id="trendRange"></span></h2>
    <svg id="trend" class="trend scatter" width="100%" viewBox="0 0 760 220" preserveAspectRatio="xMidYMid meet"></svg>
    <p class="mut">Total list-$ spend per run (one point per day). Hover a path's ROI in the table above; this tracks the account-wide total.</p>
  </div>

  <h2>Performance vs cost <span class="mut">· Values view (1.0 = top model on each axis)</span></h2>
  <svg id="scatter" class="scatter" width="100%" viewBox="0 0 760 420" preserveAspectRatio="xMidYMid meet"></svg>
  <p class="mut">PERF = power-1.5 normalized benchmark average. COST = list MTOK relative to the top performer. Upper-left = strong &amp; cheap.</p>

  <h2>Benchmarks — add missing models <span class="mut">· <a href="?all=1" id="benchToggle" style="text-decoration:underline;cursor:pointer">show all models</a></span></h2>
  <table id="benchmarks"><thead><tr>
    <th>Model</th><th>Cost</th><th>Tokens</th>
    <th>INT</th><th>COD</th><th>AGE</th><th>GPQA</th><th>HLE</th><th>IF</th><th>AA-LCR</th><th>GDP-AA</th><th>SciC</th><th>Term</th><th>AA-Omn</th><th title="tokens/sec">Speed</th><th></th>
  </tr></thead><tbody></tbody></table>
  <p class="mut" id="benchStatus">Enter benchmark scores for an unregistered or incomplete model and click Save. The dashboard will rebuild with it scored.</p>
</div>
<script>
const DATA = ${json};
let profile = 'Tax';
document.getElementById('gen').textContent = new Date(DATA.generatedAt).toLocaleString();
if (DATA.pricing && DATA.pricing.generatedAt)
  document.getElementById('pricegen').textContent = 'prices ' + new Date(DATA.pricing.generatedAt).toLocaleString();

// Coverage: how many usage models are ranked vs left unscored (no benchmark
// data), plus registered models missing benchmark partitions. Computed by the
// pipeline so the normalization stays in one place.
(function () {
  const cov = DATA.coverage;
  const el = document.getElementById('cov');
  if (!el || !cov) return;
  const parts = [];
  if (cov.unscoredActionable) {
    parts.push(cov.unscoredActionable + ' unscored ($' + cov.unscoredSpend.toFixed(0) + ')');
  }
  if (cov.incomplete) {
    parts.push(cov.incomplete + ' incomplete');
  }
  if (!parts.length) {
    el.textContent = cov.scored + ' models scored';
    return;
  }
  el.textContent = parts.join(' · ') + ' — add benchmarks';
  el.style.color = 'var(--warn)';
})();

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Live list price (blended $/Mtok): cheapest of the marketplaces we fetched.
function liveList(m){
  const v=[m.list&&m.list.openrouter, m.list&&m.list.opencode].filter(x=>typeof x==='number');
  return v.length?Math.min(...v):null;
}
// xlsx price is "stale" if it disagrees with the live price by >15%.
function isStale(m){
  const live=liveList(m), x=m.list&&m.list.xlsx;
  return live!=null && x!=null && x>0 && Math.abs(x-live)/x>0.15;
}

function subPathId(s) {
  // Match subscription name to economics path id
  // s.name is display name, s.id is the path id set in buildRollup
  return s.id;
}

function modelUsageForPath(pathId) {
  return (DATA.pathModelUsage || []).filter(u => u.pathId === pathId);
}

function rollupRows() {
  const r = DATA.subscriptions;
  if (!r || !r.subs) { return; }
  document.getElementById('rollupWindow').textContent = '· value measured over ~' + r.windowMonths + ' mo';
  const tb = document.querySelector('#rollup tbody'); tb.innerHTML = '';
  const f = (v, d = 2) => v == null ? '—' : (+v).toFixed(d);
  const LABEL = { keep: 'KEEP', review: 'REVIEW', cancel: 'CANCEL?', 'no-data': 'NO DATA', canceled: 'CANCELED' };
  let openIdx = -1;
  for (const [idx, s] of r.subs.entries()) {
    const pathId = s.id;
    const usage = modelUsageForPath(pathId);
    const hasDetail = usage.length > 0;
    const exp = hasDetail ? '<span class="expando" onclick="toggleSub(' + idx + ')" id="exp' + idx + '">\u25B8</span>' : '<span class="expando" style="cursor:default;color:transparent">\u25B8</span>';
    tb.insertAdjacentHTML('beforeend',
      '<tr>' + exp +
      '<td class="sub-name" data-idx="' + idx + '">' + escapeHtml(s.name) + '</td>' +
      '<td>$' + (Math.round(s.fee) === s.fee ? s.fee.toFixed(0) : s.fee.toFixed(2)) + '</td>' +
      '<td>' + (s.valuePerMonth == null ? '—' : '$' + f(s.valuePerMonth)) + '</td>' +
      '<td title="Historical measured list-value ROI">' + (s.roi == null ? '—' : f(s.roi) + '\u00d7') + '</td>' +
      '<td title="Quota-window monthly-equivalent ROI">' + (s.quotaRoi == null ? '—' : f(s.quotaRoi) + '\u00d7') + '</td>' +
      '<td class="mut" title="' + escapeHtml(s.usedSource || '') + '">' +
        (s.usedPct == null ? '—' : s.usedPct + '%' + (s.usedSource === 'allowance' ? ' $' : '')) + '</td>' +
      '<td><span class="verdict v-' + escapeHtml(s.verdict) + '">' + escapeHtml(LABEL[s.verdict]) + '</span>' +
        (s.endDate ? '<div class="mut" style="font-size:10px">' + escapeHtml(s.endDate) + '</div>' : '') + '</td></tr>');
    // Detail row
    const detailId = 'detail' + idx;
    const detailContent = hasDetail ? renderSubDetail(usage) : '<span class="mut">No model-level usage data for this subscription</span>';
    tb.insertAdjacentHTML('beforeend',
      '<tr id="' + detailId + '" class="detail-row"><td colspan="8">' + detailContent + '</td></tr>');
  }
  // Toggle function
  window.toggleSub = function(idx) {
    const detail = document.getElementById('detail' + idx);
    const exp = document.getElementById('exp' + idx);
    if (!detail) return;
    const isOpen = detail.classList.contains('open');
    // Close all others
    document.querySelectorAll('.detail-row.open').forEach(r => r.classList.remove('open'));
    document.querySelectorAll('.expando.open').forEach(e => { e.classList.remove('open'); e.textContent = '\u25B8'; });
    if (!isOpen) {
      detail.classList.add('open');
      if (exp) { exp.classList.add('open'); exp.textContent = '\u25BE'; }
    }
  };
  // Click on row name also toggles
  document.querySelectorAll('.sub-name').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = function() {
      const idx = this.dataset.idx;
      if (window.toggleSub) window.toggleSub(Number(idx));
    };
  });

  const t = r.totals;
  document.getElementById('rollupTotals').innerHTML =
    'You pay <b>$' + t.feePerMonth.toFixed(0) + '/mo</b> · extract ~<b>$' + t.valuePerMonth.toFixed(0) +
    '/mo</b> · net <b class="' + (t.net >= 0 ? 'spend' : 'st-under') + '">' + (t.net >= 0 ? '+' : '') +
    '$' + t.net.toFixed(0) + '/mo</b>';
}
function renderSubDetail(usage) {
  const total = usage.reduce((s, u) => s + u.cost, 0);
  const rows = usage.map(u => {
    const pct = total > 0 ? (u.cost / total * 100).toFixed(1) : '0.0';
    const tok = n => n == null ? '—' : (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
    return '<tr><td>' + escapeHtml(u.model) + '</td>' +
      '<td>$' + u.cost.toFixed(2) + '</td>' +
      '<td>' + tok(u.tokens) + '</td>' +
      '<td>' + tok(u.inputTokens) + '</td>' +
      '<td>' + tok(u.outputTokens) + '</td>' +
      '<td>' + tok(u.cacheReadTokens) + '</td>' +
      '<td>' + pct + '%</td></tr>';
  }).join('');
  return '<table class="detail-table"><thead><tr>' +
    '<th>Model</th><th>Cost ($)</th><th>Tokens</th><th>Input</th><th>Output</th><th>Cache</th><th>% of sub</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function pathRows() {
  const tb = document.querySelector('#paths tbody'); tb.innerHTML='';
  for (const p of DATA.economics) {
    const cls = /UNDERWATER/.test(p.status) ? 'st-under' : /paying off/.test(p.status) ? 'st-pay' : 'st-other';
    const pct = v => v==null||v===''?'—':(typeof v==='number'?(v*100).toFixed(0)+'%':v);
    const num = (v,d=2)=>v==null||v===''?'—':(typeof v==='number'?v.toFixed(d):v);
    // Quota: show each window's used% (the busiest one tinted by load).
    let quotaCell='<td class="mut">—</td>';
    if(p.quota && p.quota.windows && p.quota.windows.length){
      const busiest=Math.max(...p.quota.windows.map(w=>w.usedPercent));
      const qcls=busiest>=85?'st-under':busiest>=60?'stale':'mut';
      const txt=p.quota.windows.map(w=>w.label+' '+w.usedPercent+'%').join(' · ')
        + (p.quota.credits!=null?' · cr '+p.quota.credits:'');
      const tip=p.quota.windows.map(w=>w.label+': '+w.usedPercent+'% — '+(w.resetDescription||'')).join('\\n');
      quotaCell='<td class="'+qcls+'" title="'+escapeHtml(tip)+'">'+escapeHtml(txt)+'</td>';
    }
    // Break-even hint for underwater wallets: what would flip them.
    let status = escapeHtml(p.status);
    if (p.breakEven) {
      const be = p.breakEven;
      status += be.reachable
        ? ' <span class="mut">(+$'+escapeHtml(String(be.needUsd))+(be.needPct!=null?' / +'+escapeHtml(String(be.needPct))+'%':'')+' to break even)</span>'
        : ' <span class="mut">(allowance caps below fee — can\\'t break even on volume)</span>';
    }
    tb.insertAdjacentHTML('beforeend',
      '<tr><td>'+escapeHtml(p.name)+'</td><td class="mut">'+escapeHtml(p.type)+'</td><td>$'+p.fee.toFixed(0)+
      '</td><td>'+(p.valueRun==null?'—':'$'+p.valueRun.toFixed(0))+'</td><td>'+(p.covered==null?'—':'$'+p.covered.toFixed(0))+
      '</td><td>'+pct(p.util)+'</td><td>'+num(p.effMult,3)+'</td><td>'+num(p.roi,2)+
      '</td>'+quotaCell+'<td class="'+cls+'">'+status+'</td></tr>');
  }
}

let sortK='cap', sortDir=-1;
function val(m,k){
  if(k==='cap') return m['cap'+profile];
  if(k==='val') return m['val'+profile];
  if(k==='tier') return ({Frontier:3,High:2,Mid:1,Low:0})[m['tier'+profile]] ?? -1;
  if(k==='list') return liveList(m);
  if(k==='spent') return m.usage?m.usage.cost:null;
  if(k==='tokens') return m.usage?m.usage.tokens:null;
  return m[k];
}
function modelRows(){
  const tb=document.querySelector('#models tbody'); tb.innerHTML='';
  document.getElementById('profLabel').textContent='· '+(profile==='Tax'?'Professional':'Hobbyist')+' weights';
  const rows=[...DATA.models].filter(m=>m.complete);
  const maxCap=Math.max(...rows.map(m=>m['cap'+profile]||0));
  rows.sort((a,b)=>{const x=val(a,sortK),y=val(b,sortK);
    if(typeof x==='string'||typeof y==='string') return sortDir*String(x).localeCompare(String(y));
    return sortDir*(( x??-1e9)-(y??-1e9));});
  for(const m of rows){
    const tier=m['tier'+profile]||'';
    const cap=m['cap'+profile], barW=cap?Math.round(cap/maxCap*60):0;
    const f=(v,d=3)=>v==null?'—':v.toFixed(d);
    const live=liveList(m), x=m.list&&m.list.xlsx;
    const tip='xlsx '+f(x,2)+' · OR '+f(m.list&&m.list.openrouter,2)+' · OC '+f(m.list&&m.list.opencode,2);
    const listCell='<td class="'+(isStale(m)?'stale':'')+'" title="'+escapeHtml(tip)+'">'+f(live!=null?live:x,2)+'</td>';
    const spent=m.usage?'$'+m.usage.cost.toFixed(2):'—';
    const tok=n=>n==null||n===0?'—':(n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n));
    const tokens=m.usage?tok(m.usage.tokens):'—';
    tb.insertAdjacentHTML('beforeend',
      '<tr><td>'+escapeHtml(m.model)+'</td>'+
      '<td>'+f(cap)+' <span class="bar" style="width:'+barW+'px"></span></td>'+
      '<td>'+f(m['val'+profile])+'</td>'+
      '<td class="tier-'+escapeHtml(tier)+'">'+escapeHtml(tier)+'</td>'+
      listCell+
      '<td>'+f(m.minCost,3)+'</td>'+
      '<td class="mut">'+escapeHtml(m.bestPath||'—')+'</td>'+
      '<td class="'+(m.usage?'spend':'mut')+'">'+spent+'</td>'+
      '<td class="mut">'+tokens+'</td>'+
      '<td class="mut">'+escapeHtml(m.speed==null?'—':m.speed)+'</td></tr>');
  }
}
document.querySelectorAll('#models th').forEach(th=>th.onclick=()=>{
  const k=th.dataset.k; if(k===sortK) sortDir*=-1; else {sortK=k; sortDir=(k==='model'||k==='bestPath')?1:-1;}
  document.querySelectorAll('#models th').forEach(t=>t.classList.toggle('sorted',t===th));
  modelRows();
});
document.querySelectorAll('#profile button').forEach(b=>b.onclick=()=>{
  profile=b.dataset.p;
  document.querySelectorAll('#profile button').forEach(x=>x.classList.toggle('on',x===b));
  modelRows();
});
function drawScatter(){
  const svg=document.getElementById('scatter');
  const pts=(DATA.values||[]).filter(v=>typeof v.perf==='number'&&typeof v.cost==='number');
  if(!pts.length){svg.style.display='none';return;}
  const W=760,H=420,m={l:48,r:16,t:16,b:40};
  const maxCost=Math.max(1,...pts.map(p=>p.cost));
  const x=c=>m.l+(c/maxCost)*(W-m.l-m.r);
  const y=p=>H-m.b-(p)*(H-m.t-m.b);
  let s='';
  // axes
  s+='<line class="axis" x1="'+m.l+'" y1="'+m.t+'" x2="'+m.l+'" y2="'+(H-m.b)+'"/>';
  s+='<line class="axis" x1="'+m.l+'" y1="'+(H-m.b)+'" x2="'+(W-m.r)+'" y2="'+(H-m.b)+'"/>';
  // gridlines + ticks
  for(let i=0;i<=4;i++){const yp=i/4; const yy=y(yp);
    s+='<line class="axis" x1="'+m.l+'" y1="'+yy+'" x2="'+(W-m.r)+'" y2="'+yy+'" opacity="0.4"/>';
    s+='<text x="'+(m.l-6)+'" y="'+(yy+3)+'" text-anchor="end">'+yp.toFixed(2)+'</text>';}
  const xticks=Math.ceil(maxCost);
  for(let c=0;c<=xticks;c++){const xx=x(c);
    s+='<text x="'+xx+'" y="'+(H-m.b+16)+'" text-anchor="middle">'+c+'×</text>';}
  s+='<text x="'+(m.l-34)+'" y="'+(m.t+H)/2+'" transform="rotate(-90 '+(m.l-34)+' '+((m.t+H)/2)+')" text-anchor="middle">PERF</text>';
  s+='<text x="'+((m.l+W-m.r)/2)+'" y="'+(H-4)+'" text-anchor="middle">COST (× top performer $/Mtok)</text>';
  // dots — label the frontier (high perf or notably cheap)
  const labeled=[...pts].sort((a,b)=>b.perf-a.perf).slice(0,8);
  const lset=new Set(labeled.map(p=>p.model));
  for(const p of pts){const cx=x(p.cost),cy=y(p.perf);
    const short=p.model.split('/').pop();
    s+='<circle class="dot" cx="'+cx+'" cy="'+cy+'" r="4"><title>'+escapeHtml(short)+' — perf '+p.perf.toFixed(2)+', cost '+p.cost.toFixed(2)+'×</title></circle>';
    if(lset.has(p.model)) s+='<text class="lbl" x="'+(cx+6)+'" y="'+(cy+3)+'">'+escapeHtml(short)+'</text>';}
  svg.innerHTML=s;
}
// Underwater banner — the loud "you're wasting money here" signal up top.
function drawAlerts(){
  const box=document.getElementById('alertBox');
  const a=DATA.alerts||[];
  if(!a.length){box.style.display='none';return;}
  const items=a.map(x=>{
    const be=x.breakEven;
    const hint=be?(be.reachable?' — +$'+be.needUsd+(be.needPct!=null?' / +'+be.needPct+'% usage to break even':''):' — allowance caps below fee'):'';
    return escapeHtml(x.name)+' (ROI '+(x.roi!=null?x.roi.toFixed(2):'—')+hint+')';
  });
  box.className='alert';
  box.innerHTML='<b>⚠ '+a.length+' wallet'+(a.length>1?'s':'')+' underwater:</b> '+items.join(' · ');
}

// Spend-over-time line from the embedded daily snapshots.
function drawTrend(){
  const t=(DATA.trend||[]).filter(s=>typeof s.totalSpend==='number');
  if(t.length<2){return;}
  document.getElementById('trendSection').style.display='';
  document.getElementById('trendRange').textContent='· '+t[0].date+' → '+t[t.length-1].date;
  const svg=document.getElementById('trend');
  const W=760,H=220,m={l:52,r:16,t:16,b:28};
  const maxS=Math.max(1,...t.map(s=>s.totalSpend));
  // Position by elapsed calendar time, not array index — snapshots.js writes
  // at most one point per day, but a missed day (offline, a failed collect)
  // leaves a gap; index-based spacing rendered that gap the same width as a
  // one-day step, understating how long a spend jump actually took.
  const times=t.map(s=>Date.parse(s.date+'T00:00:00Z'));
  const span=Math.max(1,times[times.length-1]-times[0]);
  const x=i=>m.l+((times[i]-times[0])/span)*(W-m.l-m.r);
  const y=v=>H-m.b-(v/maxS)*(H-m.t-m.b);
  let s='';
  s+='<line class="axis" x1="'+m.l+'" y1="'+m.t+'" x2="'+m.l+'" y2="'+(H-m.b)+'"/>';
  s+='<line class="axis" x1="'+m.l+'" y1="'+(H-m.b)+'" x2="'+(W-m.r)+'" y2="'+(H-m.b)+'"/>';
  for(let i=0;i<=4;i++){const v=maxS*i/4,yy=y(v);
    s+='<line class="axis" x1="'+m.l+'" y1="'+yy+'" x2="'+(W-m.r)+'" y2="'+yy+'" opacity="0.4"/>';
    s+='<text x="'+(m.l-6)+'" y="'+(yy+3)+'" text-anchor="end">$'+v.toFixed(0)+'</text>';}
  const pts=t.map((sp,i)=>x(i)+','+y(sp.totalSpend)).join(' ');
  s+='<polyline class="line" points="'+pts+'"/>';
  t.forEach((sp,i)=>{
    const staleNote=sp.stale?' (stale — no fresh data collected)':'';
    s+='<circle class="dot'+(sp.stale?' stale':'')+'" cx="'+x(i)+'" cy="'+y(sp.totalSpend)+'" r="3"><title>'+escapeHtml(sp.date)+' — $'+sp.totalSpend.toFixed(2)+escapeHtml(staleNote)+'</title></circle>';
    if(i===0||i===t.length-1) s+='<text x="'+x(i)+'" y="'+(H-m.b+16)+'" text-anchor="'+(i===0?'start':'end')+'">'+escapeHtml(sp.date)+'</text>';
  });
  svg.innerHTML=s;
}
function benchRows(){
  const tb=document.querySelector('#benchmarks tbody'); tb.innerHTML='';
  // By default show models missing benchmark scores. With ?all=1 toggle,
  // show every registered model so you can correct any value.
  const urlParams=new URLSearchParams(window.location.search);
  const showAll=urlParams.get('all')==='1';
  let show=[...DATA.models].filter(m=>
    showAll ||
    (!m.registered || (!m.complete && m.registered && m.mtok!=null)) &&
    m.usage && (m.usage.cost>0||m.usage.tokens>5e6));
  show.sort((a,b)=> (b.usage?.cost||0) - (a.usage?.cost||0));
  // Update toggle link text
  const toggle=document.getElementById('benchToggle');
  if(toggle) toggle.textContent=showAll?'show only missing':'show all models';
  if(!show.length){tb.innerHTML='<tr><td colspan="16" class="mut">All models have scores</td></tr>';return;}
  // Fetch existing benchmark scores to pre-fill form inputs
  let existingScores=[];
  (async()=>{
    try{const r=await fetch('/benchmark-models');existingScores=await r.json();}catch{}
    for(const m of show){
      const u=m.usage;
      const tok=n=>n==null||n===0?'—':(n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n));
      const rowId='bch-'+escapeHtml(m.model).replace(/[^w-]/g,'_');
      // Map benchmark field names to form field names
      const b2f={'intRef':'INT','aaCoding':'COD','aaAgentic':'AGE','gpqa':'GPQA','hle':'HLE',
        'aaLcr':'AA-LCR','gdpval':'GDPval-AA','sciCode':'SciCode','terminalBench':'Terminal',
        'aaOmni':'AA-Omni','speed':'speed'};
      const ex=existingScores.find(x=>x.model===m.model)||{};
      const val=(f)=>ex[f]!=null&&ex[f]!==''?String(ex[f]):'';
      const inp=(name,bf)=>'<input id="'+rowId+'_'+name+'" class="bch-inp" type="text" value="'+val(bf||b2f[name]||name)+'" placeholder="—">';
      tb.insertAdjacentHTML('beforeend',
        '<tr id="'+rowId+'"><td>'+escapeHtml(m.model)+'</td>'+
        '<td>$'+(u?u.cost.toFixed(2):'0.00')+'</td><td>'+(u?tok(u.tokens):'—')+'</td>'+
        '<td>'+inp('INT','intRef')+'</td><td>'+inp('COD','aaCoding')+'</td><td>'+inp('AGE','aaAgentic')+'</td>'+
        '<td>'+inp('GPQA')+'</td><td>'+inp('HLE')+'</td><td>'+inp('IFBench','ifBench')+'</td>'+
        '<td>'+inp('AA-LCR','aaLcr')+'</td><td>'+inp('GDPval-AA','gdpval')+'</td><td>'+inp('SciCode')+'</td>'+
        '<td>'+inp('Terminal','terminalBench')+'</td><td>'+inp('AA-Omni','aaOmni')+'</td><td>'+inp('speed')+'</td>'+
        '<td><button class="bch-save" data-model="'+escapeHtml(m.model)+'">Save</button></td></tr>');
    }
  })();
  // Save handler. The server only accepts benchmark mutations from
  // localhost or with the operator's REFRESH_TOKEN. Keep the token in
  // memory only; do not persist it in browser storage.
  let benchmarkToken='';
  const postBenchmark=async(entry)=>{
    const send=()=>fetch('/benchmark',{method:'POST',headers:{'content-type':'application/json',...(benchmarkToken?{'X-Refresh-Token':benchmarkToken}:{})},body:JSON.stringify(entry)});
    let r=await send();
    if(r.status===403){
      const entered=prompt('This dashboard requires REFRESH_TOKEN to save benchmarks:');
      if(entered){benchmarkToken=entered;r=await send();}
    }
    return r;
  };
  document.querySelectorAll('.bch-save').forEach(btn=>{
    btn.onclick=async function(){
      const tr=this.closest('tr');
      const rowId=tr.id;
      const model=this.dataset.model;
      const fields=['INT','COD','AGE','GPQA','HLE','IFBench','AA-LCR','GDPval-AA','SciCode','Terminal','AA-Omni','speed'];
      const entry={model};
      for(const f of fields){
        const el=document.getElementById(rowId+'_'+f);
        const v=el?el.value.trim():'';
        if(v!=='') entry[f]=Number(v);
      }
      document.getElementById('benchStatus').textContent='Saving '+model+'...';
      this.disabled=true;
      try{
        const r=await postBenchmark(entry);
        const j=await r.json();
        if(j.ok){
          document.getElementById('benchStatus').innerHTML='<b class="spend">\u2713</b> '+model+' saved — reloading...';
          setTimeout(()=>location.reload(),1500);
        }else{
          document.getElementById('benchStatus').textContent='Error: '+j.error;
          this.disabled=false;
        }
      }catch(e){
        document.getElementById('benchStatus').textContent='Error: '+e.message+' (server running? try node src/roi-tracker/serve.js)';
        this.disabled=false;
      }
    };
  });
}
benchRows(); drawAlerts(); rollupRows(); pathRows(); modelRows(); drawTrend(); drawScatter();
</script>
</body></html>`;
}

function main() {
  const data = getData();
  const outPath = homeDataPath('roi-dashboard.html');
  fs.writeFileSync(outPath, page(data));
  console.error(`wrote ${path.relative(agentqHome(), outPath)} — open in a browser`);
}

if (require.main === module) main();
module.exports = { page };
