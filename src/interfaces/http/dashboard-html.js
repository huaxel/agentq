'use strict';

// Self-contained HTML dashboard served at `/`. Extracted verbatim from the
// orchestrator request handler to keep the router readable; edit markup here.
module.exports = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestrator</title>
<style>
:root { --bg: #0f1117; --bg2: #1a1d27; --bg3: #242836; --fg: #e4e4e7; --fg2: #a1a1aa; --accent: #6366f1; --green: #22c55e; --yellow: #eab308; --red: #ef4444; --blue: #3b82f6; --purple: #a855f7; --border: #2d3142; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--fg); padding: 1.5rem; line-height: 1.5; }
h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; }
h2 { font-size: 1.1rem; font-weight: 500; margin-bottom: 0.75rem; color: var(--fg2); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.card { background: var(--bg2); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; }
.card h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg2); margin-bottom: 0.5rem; }
.card .value { font-size: 1.75rem; font-weight: 600; }
.card .sub { font-size: 0.8rem; color: var(--fg2); margin-top: 0.25rem; }
.status-pending { color: var(--yellow); }
.status-running { color: var(--blue); }
.status-succeeded { color: var(--green); }
.status-failed { color: var(--red); }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border); }
th { color: var(--fg2); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
.badge-pending { background: #1c1917; color: var(--yellow); }
.badge-running { background: #0c4a6e; color: var(--blue); }
.badge-succeeded { background: #052e16; color: var(--green); }
.badge-failed { background: #450a0a; color: var(--red); }
.actions { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
.btn { padding: 0.4rem 0.8rem; border-radius: 0.375rem; border: 1px solid var(--border); background: var(--bg3); color: var(--fg); cursor: pointer; font-size: 0.85rem; }
.btn:hover { background: var(--border); }
.btn-accent { background: var(--accent); border-color: var(--accent); }
.btn-accent:hover { opacity: 0.9; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.auto-refresh { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--fg2); }
#sseIndicator { width: 8px; height: 8px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
#lastUpdate { font-size: 0.75rem; color: var(--fg2); }
.form-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.75rem; }
.form-grid label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--fg2); }
.form-grid input, .form-grid select, .form-grid textarea { background: var(--bg3); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.4rem 0.5rem; color: var(--fg); font: inherit; }
.form-grid .full { grid-column: 1 / -1; }
.form-actions { grid-column: 1 / -1; display: flex; gap: 0.5rem; }
.row-actions { display: flex; gap: 0.4rem; white-space: nowrap; }
.btn-approve { background: var(--green); border-color: var(--green); color: #052e16; }
.btn-approve:hover { opacity: 0.85; }
.btn-reject { background: var(--red); border-color: var(--red); color: #450a0a; }
.btn-reject:hover { opacity: 0.85; }
</style>
</head>
<body>
<h1>Orchestrator</h1>

<div class="grid" id="stats"></div>
<div class="grid" id="rateLimits"></div>
<div id="approvals"></div>

<div class="actions">
  <button class="btn btn-accent" onclick="toggleCreateForm()">+ New Task</button>
  <button class="btn" onclick="pruneTasks()" style="font-size:0.8rem">Prune Old Tasks</button>
  <button class="btn" onclick="exportTasks('csv')" style="font-size:0.8rem">Export CSV</button>
  <button class="btn" onclick="exportTasks('jsonl')" style="font-size:0.8rem">Export JSONL</button>
  <span id="bulkActions" style="display:none;margin-left:0.5rem">
    <button class="btn btn-approve" onclick="bulkApprove()" style="font-size:0.8rem">Approve Selected</button>
    <button class="btn btn-reject" onclick="bulkReject()" style="font-size:0.8rem">Reject Selected</button>
    <button class="btn" onclick="bulkDelete()" style="font-size:0.8rem;color:var(--red)">Delete Selected</button>
  </span>
  <span id="selectionCount" style="font-size:0.8rem;color:var(--fg2);margin-left:0.5rem"></span>
</div>
<div id="createForm" class="form-card" style="display:none">
  <h3>New Task</h3>
  <form onsubmit="return submitCreateTask(event)">
    <div class="form-grid">
      <label>Repo path<input name="repo" placeholder="/home/you/projects/myrepo"></label>
      <label>Issue #<input name="issue_num" type="number" min="1"></label>
      <label>Base branch<input name="base_branch" placeholder="main"></label>
      <label>Model<input name="model" placeholder="auto"></label>
      <label>Trust level
        <select name="trust_level">
          <option value="agent">agent (default — worker still needs --sandbox/--allow-untrusted to run it)</option>
          <option value="trusted_agent">trusted_agent (worker can execute it bare)</option>
          <option value="untrusted">untrusted (requires human approval before it's even claimable)</option>
        </select>
      </label>
      <label class="full">Prompt (non-issue jobs)<textarea name="prompt" rows="3" placeholder="What should the agent do? Leave blank for an issue: GitHub text is captured when enqueued."></textarea></label>
      <div class="form-actions">
        <button type="submit" class="btn btn-accent">Create</button>
        <button type="button" class="btn" onclick="toggleCreateForm()">Cancel</button>
      </div>
    </div>
  </form>
</div>

<h2>Recent Tasks</h2>
<div class="actions">
  <button class="btn" onclick="filterTasks('all')">All</button>
  <button class="btn" onclick="filterTasks('pending')">Pending</button>
  <button class="btn" onclick="filterTasks('running')">Running</button>
  <button class="btn" onclick="filterTasks('succeeded')">Succeeded</button>
  <button class="btn" onclick="filterTasks('failed')">Failed</button>
  <span class="auto-refresh"><span id="sseIndicator" class="spinner"></span> <span id="sseStatus">Connecting...</span> <span id="lastUpdate"></span></span>
</div>
<table><thead><tr><th><input type="checkbox" id="selectAll" onchange="toggleSelectAll(this)"></th><th>Status</th><th>Kind</th><th>Model</th><th>Pri</th><th>Deps</th><th>Task</th><th>Created</th><th>Completed</th></tr></thead>
<tbody id="taskTable"></tbody></table>

<div id="taskDetail" class="form-card" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
    <h3 id="detailTitle">Task Detail</h3>
    <button class="btn" onclick="closeDetail()">Close</button>
  </div>
  <div id="detailBody"></div>
</div>

<script>
let currentFilter = 'all';
let evtSource = null;

function esc(s) {
  return typeof s === 'string'
    ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
    : String(s ?? '');
}
function escClass(s) {
  // CSS class fragment: strip everything outside the safe identifier set so
  // a hostile status value can never break out of the class attribute.
  return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}
function safeHref(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '#';
    return esc(url.href);
  } catch { return '#'; }
}

// When AUTH_TOKEN is set server-side, every /api/* call below needs it too —
// there's no login form, so remember a token in localStorage and prompt once
// (not once per parallel request) the first time a call comes back 401.
let authToken = localStorage.getItem('orchestratorToken') || '';
let pendingAuthPrompt = null;

function promptForToken() {
  if (!pendingAuthPrompt) {
    pendingAuthPrompt = Promise.resolve().then(() => {
      const entered = prompt('This orchestrator requires an auth token (AUTH_TOKEN). Enter it:');
      pendingAuthPrompt = null;
      if (entered) {
        authToken = entered;
        localStorage.setItem('orchestratorToken', authToken);
      }
    });
  }
  return pendingAuthPrompt;
}

async function authFetch(url, opts = {}) {
  const withAuth = () => ({ ...opts, headers: { ...(opts.headers || {}), ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}) } });
  let res = await fetch(url, withAuth());
  if (res.status === 401) {
    await promptForToken();
    res = await fetch(url, withAuth());
  }
  return res;
}

async function postJson(url, body) {
  const res = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    alert('Request failed (' + res.status + '): ' + text);
    throw new Error(text);
  }
  return res.json().catch(() => ({}));
}

// Attribution for approve/reject — no login system here, just remember a
// name locally once, same pattern as the auth token above.
let operatorName = localStorage.getItem('orchestratorOperator') || '';
function getOperatorName() {
  if (!operatorName) {
    operatorName = (prompt('Your name (for approve/reject attribution):') || '').trim() || 'admin';
    localStorage.setItem('orchestratorOperator', operatorName);
  }
  return operatorName;
}

async function approveTask(id) {
  try {
    await postJson('/api/tasks/' + encodeURIComponent(id) + '/approve', { approved_by: getOperatorName() });
    fetchData();
  } catch { /* postJson already alerted */ }
}

async function rejectTask(id) {
  const reason = prompt('Reason for rejecting (optional):');
  if (reason === null) return; // cancelled
  try {
    await postJson('/api/tasks/' + encodeURIComponent(id) + '/reject', { rejected_by: getOperatorName(), reason: reason || null });
    fetchData();
  } catch { /* postJson already alerted */ }
}

function toggleCreateForm() {
  const el = document.getElementById('createForm');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

async function submitCreateTask(event) {
  event.preventDefault();
  const fd = new FormData(event.target);
  const issueNum = fd.get('issue_num') ? Number(fd.get('issue_num')) : undefined;
  const prompt = String(fd.get('prompt') || '');
  if (!issueNum && !prompt.trim()) {
    alert('Enter a prompt or a GitHub issue number.');
    return false;
  }
  if (issueNum && prompt.trim()) {
    alert('For an issue job, put requirements in the GitHub issue and leave Prompt blank. Its text is captured when enqueued.');
    return false;
  }
  const body = {
    kind: issueNum ? 'github_issue' : 'prompt',
    repo: fd.get('repo') || undefined,
    issue_num: issueNum,
    base_branch: fd.get('base_branch') || undefined,
    model: fd.get('model') || undefined,
    trust_level: fd.get('trust_level') || undefined,
    prompt: issueNum ? undefined : prompt,
  };
  try {
    await postJson('/api/tasks', body);
    event.target.reset();
    toggleCreateForm();
    fetchData();
  } catch { /* postJson already alerted */ }
  return false;
}

async function fetchData() {
  const [tasksRes, workersRes, usageRes, rateRes, utilRes] = await Promise.all([
    authFetch('/api/tasks?limit=50'),
    authFetch('/api/workers'),
    authFetch('/api/usage?days=7'),
    authFetch('/api/rate-limits'),
    authFetch('/api/utilization'),
  ]);
  const tasks = await tasksRes.json();
  const workers = await workersRes.json();
  const usage = await usageRes.json();
  const rateLimits = rateRes.ok ? await rateRes.json() : [];
  const utilization = utilRes.ok ? await utilRes.json() : [];
  renderStats(tasks, workers, usage);
  renderTasks(tasks);
  renderRateLimits(rateLimits, utilization);
  renderApprovals(tasks);
}

function filterTasks(status) {
  currentFilter = status;
  fetchData();
}

async function showTaskDetail(id) {
  try {
    const res = await authFetch('/api/tasks/' + encodeURIComponent(id));
    const data = await res.json();
    const delBtn = ['succeeded','failed','unverified','rejected'].includes(data.status)
      ? \` <button class="btn" style="font-size:0.7rem;padding:0.2rem 0.5rem;color:var(--red)" data-id="\${esc(id)}" onclick="deleteTask(this.dataset.id)">Delete</button>\`
      : '';
    document.getElementById('detailTitle').innerHTML = 'Task ' + esc(id.slice(0, 8)) + delBtn;
    // Fetch Jules session info if this task has one
    let julesHtml = '';
    try {
      const julesRes = await authFetch('/api/jules-sessions?limit=100');
      if (julesRes.ok) {
        const allSessions = await julesRes.json();
        const js = allSessions.find(s => s.task_id === id);
        if (js) {
          const stateColor = js.state === 'COMPLETED' || js.state === 'SUCCEEDED' ? 'var(--green)'
            : js.state === 'FAILED' || js.state === 'CANCELLED' ? 'var(--red)'
            : 'var(--accent)';
          julesHtml = \`<div style="background:var(--bg3);border:1px solid \${stateColor};border-radius:0.5rem;padding:0.75rem;margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
              <span style="font-weight:600;color:var(--fg)">🤖 Jules Session</span>
              <span class="badge" style="background:\${stateColor};color:var(--bg)">\${esc(js.state)}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-size:0.8rem">
              <div><span style="color:var(--fg2)">Phase:</span> \${esc(js.phase || '-')}</div>
              <div><span style="color:var(--fg2)">Activities:</span> \${js.activity_count || 0}</div>
              \${js.pr_url ? \`<div style="grid-column:span 2"><span style="color:var(--fg2)">PR:</span> <a href="\${safeHref(js.pr_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">\${esc(js.pr_url)}</a></div>\` : ''}
              \${js.last_activity ? \`<div style="grid-column:span 2"><span style="color:var(--fg2)">Last:</span> \${esc(js.last_activity)}</div>\` : ''}
            </div>
          </div>\`;
        }
      }
    } catch { /* Jules sessions endpoint not available */ }

    const events = (data.events || []).map(e => {
      const ts = new Date(e.created_at).toLocaleTimeString();
      let payload = {};
      try { payload = e.payload ? JSON.parse(e.payload) : {}; } catch { payload = { error: 'invalid event payload' }; }
      const detail = JSON.stringify(payload).slice(0, 200);
      return \`<tr><td style="white-space:nowrap">\${ts}</td><td><span class="badge badge-\${e.event === 'completed' ? 'succeeded' : e.event === 'failed' ? 'failed' : e.event === 'claimed' ? 'running' : 'pending'}">\${esc(e.event)}</span></td><td style="font-size:0.75rem;color:var(--fg2)">\${esc(detail)}</td></tr>\`;
    }).join('');
    const body = \`
      \${julesHtml}
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem">
        <div><span style="color:var(--fg2)">Status:</span> <span class="badge badge-\${escClass(data.status)}">\${esc(data.status)}</span></div>
        <div><span style="color:var(--fg2)">Model:</span> \${esc(data.model || '-')}</div>
        <div><span style="color:var(--fg2)">Claimed by:</span> \${esc(data.claimed_by || '-')}</div>
        <div><span style="color:var(--fg2)">Attempts:</span> \${data.attempts || 0} / \${data.max_attempts || 3}</div>
        <div><span style="color:var(--fg2)">Trust:</span> \${esc(data.trust_level || 'agent')}</div>
        <div><span style="color:var(--fg2)">Approved:</span> \${data.approved_by ? esc(data.approved_by) : 'no'}</div>
      </div>
      \${data.prompt ? \`<div style="margin-bottom:1rem"><span style="color:var(--fg2)">Prompt:</span><div style="background:var(--bg3);padding:0.5rem;border-radius:0.375rem;margin-top:0.25rem;font-size:0.8rem;white-space:pre-wrap;max-height:200px;overflow:auto">\${esc(data.prompt)}</div></div>\` : ''}
      <h4 style="color:var(--fg2);margin-bottom:0.5rem">Event Log</h4>
      <table style="font-size:0.8rem">
        <thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead>
        <tbody>\${events || '<tr><td colspan="3" style="color:var(--fg2)">No events</td></tr>'}</tbody>
      </table>
    \`;
    document.getElementById('detailBody').innerHTML = body;
    document.getElementById('taskDetail').style.display = 'block';
    document.getElementById('taskDetail').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    alert('Failed to load task detail: ' + e.message);
  }
}

function closeDetail() {
  document.getElementById('taskDetail').style.display = 'none';
}

async function deleteTask(id) {
  if (!confirm('Delete this task permanently?')) return;
  try {
    const res = await authFetch('/api/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Delete failed: ' + (err.error || res.statusText));
    }
    closeDetail();
    fetchData();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

async function pruneTasks() {
  if (!confirm('Prune all completed tasks older than 30 days?')) return;
  try {
    const res = await authFetch('/api/tasks/prune', { method: 'POST' });
    const data = await res.json();
    alert('Pruned ' + data.pruned + ' task(s)');
    fetchData();
  } catch (e) {
    alert('Prune failed: ' + e.message);
  }
}

function connectSse() {
  if (evtSource) { evtSource.close(); }
  const indicator = document.getElementById('sseIndicator');
  const statusEl = document.getElementById('sseStatus');
  indicator.className = 'spinner';
  statusEl.textContent = 'Connecting...';
  const sseUrl = authToken ? '/api/events?token=' + encodeURIComponent(authToken) : '/api/events';
  evtSource = new EventSource(sseUrl);
  evtSource.addEventListener('task-created', () => fetchData());
  evtSource.addEventListener('task-claimed', () => fetchData());
  evtSource.addEventListener('task-completed', () => fetchData());
  evtSource.addEventListener('task-approved', () => fetchData());
  evtSource.addEventListener('task-rejected', () => fetchData());
  evtSource.addEventListener('tasks-pruned', () => fetchData());
  evtSource.addEventListener('task-deleted', () => fetchData());
  evtSource.addEventListener('task-updated', () => fetchData());
  evtSource.addEventListener('tasks-bulk-updated', () => fetchData());
  evtSource.addEventListener('worker-updated', () => fetchData());
  evtSource.addEventListener('tasks-recovered', () => fetchData());
  evtSource.addEventListener('jules-state-change', () => fetchData());
  evtSource.addEventListener('jules-progress', () => fetchData());
  evtSource.addEventListener('jules-activity', () => fetchData());
  evtSource.addEventListener('jules-session-created', () => fetchData());
  evtSource.addEventListener('jules-complete', () => fetchData());
  evtSource.onerror = () => {
    indicator.style.borderTopColor = 'var(--red)';
    statusEl.textContent = 'Disconnected — reconnecting...';
    document.getElementById('lastUpdate').textContent = '';
  };
  evtSource.onopen = () => {
    indicator.style.borderTopColor = 'var(--green)';
    statusEl.textContent = 'Live';
    document.getElementById('lastUpdate').textContent = '— ' + new Date().toLocaleTimeString();
  };
}

function renderStats(tasks, workers, usage) {
  const counts = { pending: 0, running: 0, succeeded: 0, failed: 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const total = tasks.length;
  document.getElementById('stats').innerHTML = \`
    <div class="card"><h3>Pending</h3><div class="value status-pending">\${counts.pending}</div></div>
    <div class="card"><h3>Running</h3><div class="value status-running">\${counts.running}</div></div>
    <div class="card"><h3>Succeeded</h3><div class="value status-succeeded">\${counts.succeeded}</div><div class="sub">of \${total} total</div></div>
    <div class="card"><h3>Failed</h3><div class="value status-failed">\${counts.failed}</div></div>
    <div class="card"><h3>Active Workers</h3><div class="value">\${workers.length}</div></div>
    <div class="card"><h3>Total Cost (7d)</h3><div class="value">$\${(usage?.total_cost || 0).toFixed(4)}</div><div class="sub">\${(usage?.total_input||0).toLocaleString()} in / \${(usage?.total_output||0).toLocaleString()} out tokens</div></div>
  \`;
}

function renderRateLimits(rls, utilization) {
  if (!rls.length) { document.getElementById('rateLimits').innerHTML = ''; return; }
  let html = '';
  for (const rl of rls) {
    const util = (utilization || []).find(u => u.provider === rl.provider && u.metric === rl.metric);
    const pct = util ? esc(util.utilization) + '%' : '';
    const color = util && util.utilization >= 90 ? 'color:var(--red)' : util && util.utilization >= 70 ? 'color:var(--yellow)' : '';
    html += \`<div class="card"><h3>\${esc(rl.provider)} · \${esc(rl.metric)}</h3>
      <div class="value" style="\${color}">\${esc(rl.limit_val)}<span style="font-size:0.8em;color:var(--fg2)">/\${esc(rl.metric === 'rpm' ? 'min' : 'concurrent')}</span></div>
      \${util ? \`<div class="sub">\${pct} used · \${esc(util.remaining)} remaining</div>\` : ''}
      \${rl.model ? \`<div class="sub">Model: \${esc(rl.model)}</div>\` : ''}
    </div>\`;
  }
  document.getElementById('rateLimits').innerHTML = html;
}

function renderApprovals(tasks) {
  const pendingApproval = tasks.filter(t => t.approval_required && !t.approved_by);
  if (!pendingApproval.length) { document.getElementById('approvals').innerHTML = ''; return; }
  const html = \`<div class="card" style="border-color:var(--yellow)">
    <h3 style="color:var(--yellow)">⏳ Pending Approval (\${pendingApproval.length})</h3>
    <table style="font-size:0.8rem;margin-top:0.5rem">
      <thead><tr><th>Task</th><th>Kind</th><th>Model</th><th></th></tr></thead>
      <tbody>\${pendingApproval.slice(0, 10).map(t => {
        const title = t.prompt ? esc(t.prompt).slice(0, 50) : esc(t.kind);
        const id = esc(t.id);
        return \`<tr><td>\${title}</td><td>\${esc(t.kind)}</td><td>\${esc(t.model || '-')}</td>
          <td class="row-actions">
            <button class="btn btn-approve" data-id="\${id}" onclick="approveTask(this.dataset.id)">Approve</button>
            <button class="btn btn-reject" data-id="\${id}" onclick="rejectTask(this.dataset.id)">Reject</button>
          </td></tr>\`;
      }).join('')}</tbody>
    </table>
  </div>\`;
  document.getElementById('approvals').innerHTML = html;
}

function renderTasks(tasks) {
  const filtered = currentFilter === 'all' ? tasks : tasks.filter(t => t.status === currentFilter);
  const tbody = document.getElementById('taskTable');
  selectedIds = new Set();
  updateBulkUI();
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="9" style="color:var(--fg2);padding:2rem;text-align:center">No tasks</td></tr>'; return; }
  tbody.innerHTML = filtered.map(t => {
    const title = t.prompt ? esc(t.prompt).slice(0, 80) : esc(t.kind);
    const badgeClass = 'badge badge-' + escClass(t.status);
    const time = t.created_at ? new Date(t.created_at).toLocaleTimeString() : '-';
    const completed = t.finished_at ? new Date(t.finished_at).toLocaleTimeString() : '-';
    const pri = t.priority || 0;
    const deps = t.depends_on;
    const depsHtml = deps && deps.length
      ? \`<span style="font-size:0.7rem;color:var(--accent)" title="Depends on: \${esc(deps.join(', '))}">🔗 \${deps.length}</span>\`
      : '-';
    return \`<tr>
      <td><input type="checkbox" class="task-check" data-id="\${esc(t.id)}" onchange="toggleTaskSelect(this)"></td>
      <td style="cursor:pointer" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)"><span class="badge \${badgeClass}">\${esc(t.status)}</span></td>
      <td style="cursor:pointer" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)">\${esc(t.kind)}</td>
      <td style="cursor:pointer" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)">\${esc(t.model || '-')}</td>
      <td><input type="number" value="\${esc(pri)}" style="width:40px;background:var(--bg3);border:1px solid var(--border);border-radius:0.25rem;padding:0.15rem 0.3rem;color:var(--fg);font-size:0.8rem" data-id="\${esc(t.id)}" onchange="updatePriority(this.dataset.id, this.value)"></td>
      <td style="cursor:pointer;text-align:center" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)">\${depsHtml}</td>
      <td style="cursor:pointer" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)">\${title}</td>
      <td style="cursor:pointer" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)">\${time}</td>
      <td style="cursor:pointer" data-id="\${esc(t.id)}" onclick="showTaskDetail(this.dataset.id)">\${completed}</td>
    </tr>\`;
  }).join('');
  document.getElementById('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

let selectedIds = new Set();

function toggleSelectAll(el) {
  const checked = el.checked;
  document.querySelectorAll('.task-check').forEach(cb => {
    cb.checked = checked;
    const id = cb.dataset.id;
    if (checked) selectedIds.add(id); else selectedIds.delete(id);
  });
  updateBulkUI();
}

function toggleTaskSelect(el) {
  const id = el.dataset.id;
  if (el.checked) selectedIds.add(id); else selectedIds.delete(id);
  updateBulkUI();
}

function updateBulkUI() {
  const count = selectedIds.size;
  document.getElementById('bulkActions').style.display = count > 0 ? 'inline' : 'none';
  document.getElementById('selectionCount').textContent = count > 0 ? count + ' selected' : '';
}

async function updatePriority(id, priority) {
  try {
    await authFetch('/api/tasks/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: Number(priority) })
    });
    fetchData();
  } catch (e) { alert('Failed to update priority: ' + e.message); }
}

async function bulkApprove() {
  if (!selectedIds.size) return;
  if (!confirm('Approve ' + selectedIds.size + ' task(s)?')) return;
  try {
    await authFetch('/api/tasks/bulk/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds], approved_by: getOperatorName() })
    });
    fetchData();
  } catch (e) { alert('Bulk approve failed: ' + e.message); }
}

async function bulkReject() {
  if (!selectedIds.size) return;
  const reason = prompt('Rejection reason (optional):');
  if (reason === null) return;
  try {
    await authFetch('/api/tasks/bulk/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds], rejected_by: getOperatorName(), reason: reason || null })
    });
    fetchData();
  } catch (e) { alert('Bulk reject failed: ' + e.message); }
}

async function bulkDelete() {
  if (!selectedIds.size) return;
  if (!confirm('Permanently delete ' + selectedIds.size + ' task(s)?')) return;
  try {
    await authFetch('/api/tasks/bulk/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds] })
    });
    fetchData();
  } catch (e) { alert('Bulk delete failed: ' + e.message); }
}

async function exportTasks(format) {
  try {
    const res = await authFetch('/api/tasks/export?format=' + format);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tasks.' + format;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert('Export failed: ' + e.message); }
}

fetchData();
connectSse();
// Fallback: if SSE fails to connect, fall back to polling after 10s
setTimeout(() => {
  if (!evtSource || evtSource.readyState === EventSource.CLOSED) {
    setInterval(fetchData, 5000);
  }
}, 10000);
</script>
</body>
</html>`;
