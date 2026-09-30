// Keystone web client – a dependency-free single page app driven by /api/meta.
const S = {
  token: safeGet('ks_token'),
  me: null,
  perms: {},
  meta: null,
  modules: {},
  projects: [],
  users: [],
  companies: [],
  unread: 0,
};
let routeSeq = 0;

// ─── Utilities ─────────────────────────────────────────────────────────
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2Fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => (n == null || n === '' ? '' : moneyFmt.format(n));
const money2 = (n) => (n == null || n === '' ? '' : money2Fmt.format(n));
const num = (n) => (n == null || n === '' ? '' : new Intl.NumberFormat('en-US').format(n));
const fmtDate = (s) => (s ? new Date(String(s).length === 10 ? `${s}T00:00` : s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const fmtDateTime = (s) => (s ? new Date(String(s).includes('T') ? s : `${String(s).replace(' ', 'T')}Z`).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const pill = (s) => (s ? `<span class="pill s-${slug(s)}">${esc(s)}</span>` : '');
const userName = (id) => S.users.find((u) => u.id === Number(id))?.name || (id ? `User #${id}` : '');
const companyName = (id) => S.companies.find((c) => c.id === Number(id))?.name || (id ? `Company #${id}` : '');
const labelize = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const today = () => new Date().toISOString().slice(0, 10);

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

async function api(method, url, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (S.token) init.headers.Authorization = `Bearer ${S.token}`;
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(`/api${url}`, init);
  if (res.status === 401 && url !== '/auth/login') {
    S.token = null; safeSet('ks_token', null);
    location.hash = '#/login';
    throw new Error('Session expired');
  }
  if (res.status === 204) return null;
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.errors = data.errors;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function download(url, filename) {
  const res = await api('GET', url, undefined, { raw: true });
  if (!res.ok) return toast('Download failed', true);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function downloadText(text, filename, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
}

function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const e = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(labelize).map(e).join(','), ...rows.map((r) => cols.map((c) => e(r[c])).join(','))].join('\n');
}

function modal(html, onMount) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  $$('[data-close]', back).forEach((b) => b.addEventListener('click', close));
  onMount?.(back, close);
  return close;
}

const can = (moduleKey, level = 'read') => ({ none: 0, read: 1, write: 2, admin: 3 }[S.perms[moduleKey] || 'none'] >= { read: 1, write: 2, admin: 3 }[level]);
const isAdmin = () => S.me?.role === 'admin';

// ─── Routing ───────────────────────────────────────────────────────────
function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

function recordHref(mod, rec, projectId) {
  const m = S.modules[mod];
  return m?.scope === 'company' ? `#/m/${mod}/${rec.id ?? rec}` : `#/p/${projectId ?? rec.project_id}/m/${mod}/${rec.id ?? rec}`;
}

async function route() {
  const seq = ++routeSeq;
  const { parts, query } = parseHash();
  if (!S.token) return renderLogin();
  if (!S.me) {
    try { await bootstrap(); } catch { return renderLogin(); }
  }
  if (parts[0] === 'login') { location.hash = '#/'; return; }
  const pid = parts[0] === 'p' ? Number(parts[1]) : null;
  renderShell(pid, parts);
  const main = $('#main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  const guard = () => seq === routeSeq;
  try {
    if (!parts.length) return await viewPortfolio(main, guard);
    if (parts[0] === 'my-items') return await viewMyItems(main, guard);
    if (parts[0] === 'integrations' && parts[1] === 'new') return await viewNewConnection(main, parts[2]);
    if (parts[0] === 'integrations' && parts[1]) return await viewConnection(main, Number(parts[1]), guard);
    if (parts[0] === 'integrations') return await viewIntegrations(main, guard);
    if (parts[0] === 'webhooks') return await viewWebhooks(main, guard);
    if (parts[0] === 'developers') return await viewDevelopers(main, guard);
    if (parts[0] === 'admin' && parts[1] === 'users') return await viewUsers(main, guard);
    if (parts[0] === 'admin' && parts[1] === 'audit') return await viewAudit(main, guard);
    if (parts[0] === 'm') return await moduleRoute(main, null, parts.slice(1), query, guard);
    if (parts[0] === 'p' && pid) {
      const rest = parts.slice(2);
      if (!rest.length) return await viewDashboard(main, pid, guard);
      if (rest[0] === 'budget') return await viewBudget(main, pid, guard);
      if (rest[0] === 'reports') return await viewReports(main, pid, rest[1], guard);
      if (rest[0] === 'team') return await viewTeam(main, pid, guard);
      if (rest[0] === 'settings') return await viewProjectSettings(main, pid);
      if (rest[0] === 'm') return await moduleRoute(main, pid, rest.slice(1), query, guard);
    }
    main.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (err) {
    if (guard()) main.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(err.message)}</p></div>`;
  }
}

async function moduleRoute(main, pid, parts, query, guard) {
  const [moduleKey, id, action] = parts;
  const mod = S.modules[moduleKey];
  if (!mod) { main.innerHTML = '<div class="empty">Unknown tool.</div>'; return; }
  if (id === 'new') return viewForm(main, pid, mod, null, query);
  if (id && action === 'edit') return viewForm(main, pid, mod, Number(id));
  if (id) return viewDetail(main, pid, mod, Number(id), guard);
  return viewList(main, pid, mod, query, guard);
}

async function bootstrap() {
  const [me, meta] = await Promise.all([api('GET', '/me'), api('GET', '/meta')]);
  S.me = me.user;
  S.perms = me.permissions;
  S.unread = me.unread;
  S.meta = meta;
  S.modules = Object.fromEntries(meta.modules.map((m) => [m.key, m]));
  await refreshLookups();
}

async function refreshLookups() {
  const [projects, users, companies] = await Promise.all([
    api('GET', '/projects'),
    api('GET', '/users'),
    can('directory') ? api('GET', '/company/modules/directory?limit=1000&sort=name&dir=asc') : { items: [] },
  ]);
  S.projects = projects;
  S.users = users;
  S.companies = companies.items.map((c) => ({ id: c.id, name: c.name, email: c.email }));
}

// ─── Login ─────────────────────────────────────────────────────────────
function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login"><form class="box" id="login-form">
      <div class="logo" style="color:var(--text);margin-bottom:18px"><span class="logo-mark">▲</span> Keystone</div>
      <h1>Sign in</h1>
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field mt"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <div class="form-error mt" id="login-error"></div>
      <button class="btn primary mt" style="width:100%;justify-content:center">Sign in</button>
      <div class="demo">Demo accounts (password <code>keystone123</code>):<br>
        ${[['admin', 'Admin'], ['pm', 'Project Manager'], ['super', 'Superintendent'], ['sub', 'Subcontractor'], ['owner', 'Owner (read-only)']]
          .map(([u, l]) => `<button type="button" class="btn small" data-demo="${u}@keystone.test">${l}</button>`).join('')}
      </div>
    </form></div>`;
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => { $('#email').value = b.dataset.demo; $('#password').value = 'keystone123'; }));
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('POST', '/auth/login', { email: $('#email').value, password: $('#password').value });
      S.token = res.token; safeSet('ks_token', res.token);
      S.me = null;
      location.hash = '#/';
      route();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  S.token = null; S.me = null; safeSet('ks_token', null);
  location.hash = '#/login';
  renderLogin();
}

// ─── Shell ─────────────────────────────────────────────────────────────
function renderShell(pid, parts) {
  const app = document.getElementById('app');
  if (!$('#main')) {
    app.innerHTML = `
      <header class="topbar">
        <button class="icon-btn hamburger" id="hamburger" aria-label="Menu">☰</button>
        <a class="logo" href="#/"><span class="logo-mark">▲</span><span>Keystone</span></a>
        <select class="project-switch" id="project-switch" aria-label="Project"></select>
        <div class="search"><input id="global-search" type="search" placeholder="Search RFIs, submittals, companies…" autocomplete="off"><div class="search-results hidden" id="search-results"></div></div>
        <div class="spacer"></div>
        <button class="icon-btn" id="theme-btn" title="Toggle theme">◐</button>
        <button class="icon-btn" id="bell" title="Notifications">🔔<span class="badge-dot hidden" id="unread"></span></button>
        <button class="icon-btn" id="user-btn" title="Account">👤</button>
      </header>
      <div class="shell"><nav class="sidebar" id="sidebar"></nav><main class="main" id="main"></main></div>`;
    bindTopbar();
  }
  const sel = $('#project-switch');
  sel.innerHTML = `<option value="">Company Home</option>${S.projects.map((p) => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.number ? `${p.number} – ` : '')}${esc(p.name)}</option>`).join('')}`;
  const unread = $('#unread');
  unread.textContent = S.unread;
  unread.classList.toggle('hidden', !S.unread);
  $('#sidebar').innerHTML = pid ? projectNav(pid, parts) : companyNav(parts);
  $('#sidebar').classList.remove('open');
}

function navLink(href, icon, label, active, extra = '') {
  return `<a href="${href}" class="${active ? 'active' : ''}"><span class="ico">${icon}</span><span>${esc(label)}</span>${extra}</a>`;
}

function projectNav(pid, parts) {
  const cur = parts[2] === 'm' ? parts[3] : parts[2] || 'home';
  let html = navLink(`#/p/${pid}`, '🏠', 'Project Home', cur === 'home');
  for (const [gk, gl] of Object.entries(S.meta.groups)) {
    const mods = S.meta.modules.filter((m) => m.group === gk && m.scope === 'project' && can(m.key));
    const extras = [];
    if (gk === 'financials' && can('budget')) extras.push(navLink(`#/p/${pid}/budget`, '📊', 'Budget Overview', cur === 'budget'));
    if (!mods.length && !extras.length) continue;
    html += `<div class="section">${esc(gl)}</div>${extras.join('')}`;
    html += mods.map((m) => navLink(`#/p/${pid}/m/${m.key}`, m.icon, m.key === 'budget' ? 'Budget Lines' : m.label, cur === m.key)).join('');
  }
  html += `<div class="section">Project</div>${navLink(`#/p/${pid}/reports`, '📈', 'Reports', cur === 'reports')}${navLink(`#/p/${pid}/team`, '👷', 'Team', cur === 'team')}`;
  if (['admin', 'manager'].includes(S.me.role)) html += navLink(`#/p/${pid}/settings`, '⚙️', 'Project Settings', cur === 'settings');
  return html;
}

function companyNav(parts) {
  const cur = parts[0] === 'm' ? parts[1] : parts.join('/') || 'home';
  let html = `<div class="section">Company</div>${navLink('#/', '🗂️', 'Portfolio', cur === 'home')}${navLink('#/my-items', '📥', 'My Open Items', cur === 'my-items')}`;
  for (const m of S.meta.modules.filter((x) => x.scope === 'company' && can(x.key))) html += navLink(`#/m/${m.key}`, m.icon, m.label, cur === m.key);
  html += `<div class="section">Connect</div>${navLink('#/developers', '🔑', 'API & Developers', cur === 'developers')}`;
  if (isAdmin()) {
    html += navLink('#/integrations', '🔌', 'Integrations', cur.startsWith('integrations'));
    html += navLink('#/webhooks', '📡', 'Webhooks', cur === 'webhooks');
    html += `<div class="section">Admin</div>${navLink('#/admin/users', '👥', 'Users & Permissions', cur === 'admin/users')}${navLink('#/admin/audit', '🧾', 'Audit Log', cur === 'admin/audit')}`;
  }
  return html;
}

function bindTopbar() {
  $('#project-switch').addEventListener('change', (e) => { location.hash = e.target.value ? `#/p/${e.target.value}` : '#/'; });
  $('#hamburger').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    safeSet('ks_theme', root.dataset.theme);
  });
  let timer;
  const input = $('#global-search');
  const box = $('#search-results');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { box.classList.add('hidden'); return; }
      const results = await api('GET', `/search?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.length ? results.map((r) => `<a href="${recordHref(r.module, r, r.project_id)}"><span class="tag">${esc(r.module_label)}</span> <strong>${esc(r.number)}</strong> ${esc(r.title)} ${pill(r.status)}<div class="muted" style="font-size:12px">${esc(r.project || 'Company')}</div></a>`).join('') : '<div class="empty">No matches</div>';
      box.classList.remove('hidden');
    }, 200);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) box.classList.add('hidden');
    if (!e.target.closest('.menu') && !e.target.closest('#bell') && !e.target.closest('#user-btn')) $$('.menu').forEach((m) => m.remove());
  });
  box.addEventListener('click', () => { box.classList.add('hidden'); input.value = ''; });
  $('#bell').addEventListener('click', async () => {
    $$('.menu').forEach((m) => m.remove());
    const list = await api('GET', '/notifications');
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `<div class="item" style="display:flex"><strong>Notifications</strong><a href="#" style="margin-left:auto" id="mark-all">Mark all read</a></div>` +
      (list.length ? list.map((n) => `<a class="item ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/')}" data-nid="${n.id}">${esc(n.title)}<div class="muted" style="font-size:12px">${fmtDateTime(n.created_at)}</div></a>`).join('') : '<div class="empty">You are all caught up.</div>');
    document.body.appendChild(menu);
    $('#mark-all', menu).addEventListener('click', async (e) => { e.preventDefault(); await api('POST', '/notifications/read', {}); S.unread = 0; $('#unread').classList.add('hidden'); menu.remove(); });
    $$('[data-nid]', menu).forEach((a) => a.addEventListener('click', () => {
      api('POST', '/notifications/read', { ids: [Number(a.dataset.nid)] }).then(() => api('GET', '/me')).then((me) => { S.unread = me.unread; $('#unread').textContent = S.unread; $('#unread').classList.toggle('hidden', !S.unread); });
      menu.remove();
    }));
  });
  $('#user-btn').addEventListener('click', () => {
    $$('.menu').forEach((m) => m.remove());
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.style.width = '260px';
    menu.innerHTML = `<div class="item"><strong>${esc(S.me.name)}</strong><div class="muted">${esc(S.me.email)}</div><div class="muted">${esc(S.meta.roles[S.me.role] || S.me.role)}</div></div>
      <a class="item" href="#/my-items">My open items</a><a class="item" href="#/developers">API keys</a><a class="item" href="#" id="logout">Sign out</a>`;
    document.body.appendChild(menu);
    $('#logout', menu).addEventListener('click', (e) => { e.preventDefault(); logout(); });
  });
}

// ─── Portfolio & My Items ──────────────────────────────────────────────
async function viewPortfolio(main, guard) {
  const data = await api('GET', '/portfolio');
  if (!guard()) return;
  const ps = data.projects;
  const totalValue = ps.reduce((s, p) => s + (p.contract_value || 0), 0);
  const showFin = ps.some((p) => p.financials);
  main.innerHTML = `
    <div class="page-head"><div class="title"><h1>Portfolio</h1><div class="sub">${ps.length} project(s) · ${esc(S.me.name)}</div></div>
      ${['admin', 'manager'].includes(S.me.role) ? '<button class="btn primary" id="new-project">+ New Project</button>' : ''}</div>
    <div class="grid cols-4 kpis" style="margin-bottom:16px">
      ${kpi('Active Projects', ps.filter((p) => p.active).length)}
      ${kpi('Portfolio Value', money(totalValue))}
      ${kpi('Open Items', num(ps.reduce((s, p) => s + p.open_items, 0)))}
      ${kpi('Overdue Items', num(ps.reduce((s, p) => s + p.overdue_items, 0)), ps.some((p) => p.overdue_items) ? 'bad' : 'ok')}
    </div>
    <div class="card"><h2>Projects</h2>
      <div class="table-wrap"><table><thead><tr><th>Project</th><th>Stage</th><th>Location</th><th class="num">Contract Value</th><th class="num">Open RFIs</th><th class="num">Open Submittals</th><th class="num">Open Punch</th><th class="num">Overdue</th>${showFin ? '<th class="num">Revised Budget</th><th class="num">Projected Over/Under</th>' : ''}</tr></thead>
      <tbody>${ps.map((p) => `<tr class="click" data-href="#/p/${p.id}"><td><strong>${esc(p.name)}</strong><div class="muted">${esc(p.number || '')} ${esc(p.project_type || '')}</div></td><td>${pill(p.stage)}</td><td>${esc([p.city, p.state].filter(Boolean).join(', '))}</td>
        <td class="num">${money(p.contract_value)}</td><td class="num">${p.open_rfis ?? '—'}</td><td class="num">${p.open_submittals ?? '—'}</td><td class="num">${p.open_punch ?? '—'}</td><td class="num ${p.overdue_items ? 'overdue' : ''}">${p.overdue_items}</td>
        ${showFin ? `<td class="num">${p.financials ? money(p.financials.revised_budget) : '—'}</td><td class="num ${p.financials?.projected_over_under < 0 ? 'neg' : ''}">${p.financials ? money(p.financials.projected_over_under) : '—'}</td>` : ''}</tr>`).join('') || '<tr><td colspan="10" class="empty">No projects yet.</td></tr>'}</tbody></table></div>
    </div>
    <div class="card"><h2>My Open Items <span class="right"><a href="#/my-items">View all</a></span></h2>${itemsTable(data.my_items.slice(0, 10), true)}</div>`;
  bindRowLinks(main);
  $('#new-project')?.addEventListener('click', () => projectModal());
}

function kpi(label, value, cls = '', hint = '') {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function itemsTable(items, showProject = false) {
  if (!items.length) return '<div class="empty">Nothing assigned to you. 🎉</div>';
  const pname = (id) => S.projects.find((p) => p.id === id)?.name || '';
  return `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Title</th>${showProject ? '<th>Project</th>' : ''}<th>Status</th><th>Due</th></tr></thead><tbody>
    ${items.map((i) => `<tr class="click" data-href="${recordHref(i.module, i, i.project_id)}"><td class="nowrap"><span class="tag">${esc(i.module_label)}</span> ${esc(i.number)}</td><td>${esc(i.title)}</td>${showProject ? `<td>${esc(pname(i.project_id))}</td>` : ''}<td>${pill(i.status)}</td><td class="${i.overdue ? 'overdue' : ''} nowrap">${fmtDate(i.due)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function bindRowLinks(root) {
  $$('[data-href]', root).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input,select')) location.hash = tr.dataset.href; }));
}

async function viewMyItems(main, guard) {
  const items = await api('GET', '/my-items');
  if (!guard()) return;
  main.innerHTML = `<div class="page-head"><div class="title"><h1>My Open Items</h1><div class="sub">Everything where you are the assignee or ball-in-court, across all projects.</div></div></div><div class="card">${itemsTable(items, true)}</div>`;
  bindRowLinks(main);
}

function projectModal(project) {
  const f = (k, label, type = 'text') => `<div class="field"><label>${label}</label><input name="${k}" type="${type}" value="${esc(project?.[k] ?? '')}" ${type === 'number' ? 'step="any"' : ''}></div>`;
  modal(`<h2>${project ? 'Edit Project' : 'New Project'}</h2><form id="pform"><div class="form-grid">
    <div class="field wide"><label>Name <span class="req">*</span></label><input name="name" required value="${esc(project?.name || '')}"></div>
    ${f('number', 'Project #')}<div class="field"><label>Stage</label><select name="stage">${['Bidding', 'Pre-Construction', 'Course of Construction', 'Post-Construction', 'Closeout', 'Warranty'].map((s) => `<option ${project?.stage === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    ${f('project_type', 'Type')}${f('contract_value', 'Contract Value', 'number')}${f('address', 'Address')}${f('city', 'City')}${f('state', 'State')}${f('zip', 'ZIP')}
    ${f('start_date', 'Start Date', 'date')}${f('completion_date', 'Completion Date', 'date')}
    <div class="field wide"><label>Description</label><textarea name="description">${esc(project?.description || '')}</textarea></div>
  </div><div class="form-error mt" id="perr"></div><div class="btn-row mt"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (root, close) => {
    $('#pform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      body.contract_value = body.contract_value ? Number(body.contract_value) : null;
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      try {
        const p = project ? await api('PATCH', `/projects/${project.id}`, body) : await api('POST', '/projects', body);
        close();
        await refreshLookups();
        toast('Project saved');
        location.hash = `#/p/${p.id}`;
        route();
      } catch (err) { $('#perr', root).textContent = err.message; }
    });
  });
}

// ─── Project dashboard ─────────────────────────────────────────────────
async function viewDashboard(main, pid, guard) {
  const d = await api('GET', `/projects/${pid}/dashboard`);
  if (!guard()) return;
  const p = d.project;
  const fin = d.financials;
  const counts = Object.entries(d.counts).filter(([, c]) => c.total);
  const maxOpen = Math.max(1, ...counts.map(([, c]) => c.open));
  main.innerHTML = `
    <div class="page-head"><div class="title"><div class="breadcrumb">${esc(p.number || '')} · ${esc(p.project_type || '')}</div><h1>${esc(p.name)}</h1>
      <div class="sub">${esc([p.address, p.city, p.state].filter(Boolean).join(', '))} · ${pill(p.stage)} · ${fmtDate(p.start_date)} → ${fmtDate(p.completion_date)}</div></div>
      <div class="btn-row">${can('rfis', 'write') ? `<a class="btn" href="#/p/${pid}/m/rfis/new">+ RFI</a>` : ''}${can('daily_logs', 'write') ? `<a class="btn" href="#/p/${pid}/m/daily_logs/new">+ Daily Log</a>` : ''}${can('observations', 'write') ? `<a class="btn" href="#/p/${pid}/m/observations/new">+ Observation</a>` : ''}</div></div>
    <div class="grid cols-4 kpis" style="margin-bottom:16px">
      ${kpi('Contract Value', money(p.contract_value))}
      ${d.schedule.percent_complete != null ? kpi('Schedule Progress', `${d.schedule.percent_complete}%`, '', `${d.schedule.activities} activities`) : kpi('Open Items', num(counts.reduce((s, [, c]) => s + c.open, 0)))}
      ${kpi('Overdue Items', num(counts.reduce((s, [, c]) => s + c.overdue, 0)), counts.some(([, c]) => c.overdue) ? 'bad' : 'ok')}
      ${d.safety ? kpi('Days Since Incident', d.safety.days_since_last_incident ?? '—', '', `${d.safety.recordables} recordable · ${d.safety.near_misses} near miss`) : kpi('Team', d.team.length)}
    </div>
    <div class="grid cols-2">
      <div>
        <div class="card"><h2>My Open Items</h2>${itemsTable(d.my_items)}</div>
        <div class="card"><h2>Open Items by Tool</h2><div class="bar-chart">${counts.filter(([, c]) => c.open).map(([k, c]) => `<div class="row"><a href="#/p/${pid}/m/${k}?open=true">${esc(S.modules[k].label)}</a><div><div class="bar ${c.overdue ? 'bad' : ''}" style="width:${Math.max(4, (c.open / maxOpen) * 100)}%"></div></div><div class="right">${c.open}${c.overdue ? ` <span class="overdue">(${c.overdue})</span>` : ''}</div></div>`).join('') || '<div class="empty">No open items.</div>'}</div>
          <div class="muted" style="font-size:12px">Red = has overdue items (count in parentheses)</div></div>
        ${d.manpower?.length ? `<div class="card"><h2>Recent Daily Logs</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Weather</th><th class="num">High °F</th><th class="num">Workers</th></tr></thead><tbody>${d.manpower.map((m) => `<tr><td>${fmtDate(m.date)}</td><td>${esc(m.weather || '')}</td><td class="num">${m.high ?? ''}</td><td class="num">${m.workers}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      </div>
      <div>
        ${fin ? `<div class="card"><h2>Financial Snapshot <span class="right"><a href="#/p/${pid}/budget">Budget →</a></span></h2><div class="grid cols-2">
          ${kpi('Revised Prime Contract', money(fin.revised_prime_contract))}${kpi('Revised Budget', money(fin.revised_budget))}
          ${kpi('Committed Costs', money(fin.committed_costs))}${kpi('Projected Over/Under', money(fin.projected_over_under), fin.projected_over_under < 0 ? 'bad' : 'ok')}
          ${kpi('Billed to Owner', money(fin.prime_invoiced))}${kpi('Pending Changes', money(fin.pending_prime_changes))}</div></div>` : ''}
        ${d.schedule.upcoming.length ? `<div class="card"><h2>Upcoming Schedule <span class="right"><a href="#/p/${pid}/m/schedule?view=gantt">Gantt →</a></span></h2>${d.schedule.upcoming.map((a) => `<div style="margin:8px 0"><div style="display:flex;gap:8px"><a href="#/p/${pid}/m/schedule/${a.id}">${esc(a.name)}</a><span class="muted" style="margin-left:auto">${fmtDate(a.finish_date)}</span></div><div class="progress"><div style="width:${a.percent_complete || 0}%"></div></div></div>`).join('')}</div>` : ''}
        <div class="card"><h2>Recent Activity</h2>${activityList(d.activity, pid)}</div>
        <div class="card"><h2>Project Team <span class="right"><a href="#/p/${pid}/team">Manage</a></span></h2>${d.team.map((u) => `<div style="display:flex;gap:8px;padding:4px 0"><span>${esc(u.name)}</span><span class="muted">${esc(u.title || '')}</span><span class="tag" style="margin-left:auto">${esc(S.meta.roles[u.role] || u.role)}</span></div>`).join('')}</div>
      </div>
    </div>`;
  bindRowLinks(main);
}

function activityList(items, pid) {
  if (!items.length) return '<div class="empty">No activity yet.</div>';
  return items.map((a) => `<div class="activity"><div>${a.record_id && a.module ? `<a href="${recordHref(a.module, a.record_id, pid)}">${esc(a.summary || a.action)}</a>` : esc(a.summary || a.action)}</div><div class="meta">${esc(a.actor)} · ${fmtDateTime(a.ts)}${a.module ? ` · ${esc(S.modules[a.module]?.label || a.module)}` : ''}</div></div>`).join('');
}

// ─── Generic list view ─────────────────────────────────────────────────
function listColumns(mod) {
  return mod.fields.filter((f) => f.list && f.type !== 'lines');
}

function cell(field, rec) {
  const v = rec[field.key];
  if (field.key === 'status') return pill(v);
  if (v == null || v === '') return '';
  switch (field.type) {
    case 'currency': return money(v);
    case 'percent': return `${v}%`;
    case 'number': return num(v);
    case 'date': return `<span class="${rec.overdue && field.key === S.modules[rec.module]?.dueField ? 'overdue' : ''}">${fmtDate(v)}</span>`;
    case 'datetime': return fmtDateTime(v);
    case 'boolean': return v ? '✓' : '';
    case 'user': return esc(userName(v));
    case 'company': return esc(companyName(v));
    case 'select': return field.key === 'priority' ? `<span class="${v === 'Urgent' || v === 'High' ? 'overdue' : ''}">${esc(v)}</span>` : esc(v);
    default: return esc(String(v).length > 80 ? `${String(v).slice(0, 80)}…` : v);
  }
}

async function viewList(main, pid, mod, query, guard) {
  const base = pid ? `/projects/${pid}/modules/${mod.key}` : `/company/modules/${mod.key}`;
  const hrefBase = pid ? `#/p/${pid}/m/${mod.key}` : `#/m/${mod.key}`;
  const state = { q: query.q || '', status: query.status || '', open: query.open === 'true', overdue: query.overdue === 'true', mine: query.mine === 'true', sort: query.sort || '', dir: query.dir || 'desc', view: query.view || (safeGet(`ks_view_${mod.key}`) || 'table') };
  if (state.view === 'gantt' && mod.key !== 'schedule') state.view = 'table';
  const cols = listColumns(mod);
  const statusOk = mod.statuses.length > 1;
  main.innerHTML = `
    <div class="page-head"><div class="title"><div class="breadcrumb">${pid ? esc(S.projects.find((p) => p.id === pid)?.name || '') : 'Company'} · ${esc(S.meta.groups[mod.group])}</div><h1>${mod.icon} ${esc(mod.label)}</h1></div>
      <div class="btn-row">${mod.key === 'budget' ? `<a class="btn" href="#/p/${pid}/budget">📊 Budget Overview</a>` : ''}<button class="btn" id="export">⬇ Export CSV</button>${can(mod.key, 'write') ? `<a class="btn primary" href="${hrefBase}/new">+ Create ${esc(mod.singular)}</a>` : ''}</div></div>
    <div class="toolbar no-print">
      <input type="search" id="q" placeholder="Search ${esc(mod.label)}…" value="${esc(state.q)}">
      ${statusOk ? `<select id="status"><option value="">All statuses</option>${mod.statuses.map((s) => `<option ${state.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
      ${mod.closedStatuses.length ? `<label><input type="checkbox" id="open" ${state.open ? 'checked' : ''}> Open only</label>` : ''}
      ${mod.dueField ? `<label><input type="checkbox" id="overdue" ${state.overdue ? 'checked' : ''}> Overdue</label>` : ''}
      ${mod.assigneeFields.length ? `<label><input type="checkbox" id="mine" ${state.mine ? 'checked' : ''}> Assigned to me</label>` : ''}
      <span style="flex:1"></span>
      <div class="seg" id="views"><button data-view="table" class="${state.view === 'table' ? 'on' : ''}">☰ List</button>${statusOk ? `<button data-view="board" class="${state.view === 'board' ? 'on' : ''}">▦ Board</button>` : ''}${mod.key === 'schedule' ? `<button data-view="gantt" class="${state.view === 'gantt' ? 'on' : ''}">▬ Gantt</button>` : ''}</div>
    </div>
    <div id="list-body"><div class="empty">Loading…</div></div>`;

  async function load() {
    const params = new URLSearchParams({ limit: 500 });
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);
    if (state.open) params.set('open', 'true');
    if (state.overdue) params.set('overdue', 'true');
    if (state.mine) params.set('assignee', 'me');
    if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
    const { items, total } = await api('GET', `${base}?${params}`);
    if (!guard()) return;
    const body = $('#list-body');
    if (state.view === 'board') return renderBoard(body, mod, items, pid, load);
    if (state.view === 'gantt') return renderGantt(body, items, pid);
    body.innerHTML = `<div class="table-wrap"><table><thead><tr><th class="sortable" data-sort="number">#</th>${cols.map((c) => `<th class="sortable ${['currency', 'number', 'percent'].includes(c.type) ? 'num' : ''}" data-sort="${c.key}">${esc(c.label)}${state.sort === c.key ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('')}${mod.key === 'commitments' || mod.key === 'prime_contracts' ? '<th class="num">Revised Value</th><th class="num">Invoiced</th>' : ''}${['change_orders', 'invoices', 'estimates'].includes(mod.key) ? '<th class="num">Total</th>' : ''}</tr></thead>
      <tbody>${items.map((r) => `<tr class="click" data-href="${hrefBase}/${r.id}"><td class="nowrap"><a href="${hrefBase}/${r.id}">${esc(r.number)}</a>${r.overdue ? ' <span class="overdue" title="Overdue">●</span>' : ''}</td>${cols.map((c) => `<td class="${['currency', 'number', 'percent'].includes(c.type) ? 'num' : ''}">${cell(c, r)}</td>`).join('')}
        ${mod.key === 'commitments' || mod.key === 'prime_contracts' ? `<td class="num">${money(r.computed?.revised_contract_value)}</td><td class="num">${money(r.computed?.invoiced_to_date)}</td>` : ''}
        ${mod.key === 'change_orders' ? `<td class="num">${money(r.computed?.total)}</td>` : ''}${mod.key === 'invoices' ? `<td class="num">${money(r.computed?.gross_amount)}</td>` : ''}${mod.key === 'estimates' ? `<td class="num">${money(r.computed?.total)}</td>` : ''}</tr>`).join('')
        || `<tr><td colspan="${cols.length + 3}" class="empty">No ${esc(mod.label.toLowerCase())} match these filters.${can(mod.key, 'write') ? ` <a href="${hrefBase}/new">Create one</a>.` : ''}</td></tr>`}</tbody></table></div>
      <div class="muted mt">${items.length} of ${total} shown</div>`;
    bindRowLinks(body);
    $$('th[data-sort]', body).forEach((th) => th.addEventListener('click', () => {
      state.dir = state.sort === th.dataset.sort && state.dir === 'asc' ? 'desc' : 'asc';
      state.sort = th.dataset.sort;
      load();
    }));
  }

  let t;
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; clearTimeout(t); t = setTimeout(load, 250); });
  $('#status')?.addEventListener('change', (e) => { state.status = e.target.value; load(); });
  $('#open')?.addEventListener('change', (e) => { state.open = e.target.checked; load(); });
  $('#overdue')?.addEventListener('change', (e) => { state.overdue = e.target.checked; load(); });
  $('#mine')?.addEventListener('change', (e) => { state.mine = e.target.checked; load(); });
  $$('#views button').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    safeSet(`ks_view_${mod.key}`, state.view);
    $$('#views button').forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  $('#export').addEventListener('click', () => download(`${base}/export.csv?${new URLSearchParams({ q: state.q, status: state.status })}`, `${mod.key}-${today()}.csv`));
  await load();
}

function renderBoard(body, mod, items, pid, reload) {
  const writable = can(mod.key, 'write');
  body.innerHTML = `<div class="board">${mod.statuses.map((s) => {
    const cards = items.filter((i) => i.status === s);
    return `<div class="column" data-status="${esc(s)}"><h3><span>${esc(s)}</span><span class="muted">${cards.length}</span></h3>
      ${cards.map((r) => `<div class="kcard" draggable="${writable}" data-id="${r.id}" data-href="${recordHref(mod.key, r, pid)}"><div class="num">${esc(r.number)}${r.overdue ? ' <span class="overdue">● overdue</span>' : ''}</div><div>${esc(r.title)}</div>
        ${mod.assigneeFields[0] && r[mod.assigneeFields[0]] ? `<div class="muted" style="font-size:12px">👤 ${esc(userName(r[mod.assigneeFields[0]]))}</div>` : ''}${mod.dueField && r[mod.dueField] ? `<div class="muted" style="font-size:12px">📅 ${fmtDate(r[mod.dueField])}</div>` : ''}</div>`).join('')}
    </div>`;
  }).join('')}</div>${writable ? '<div class="muted mt">Drag cards between columns to change status.</div>' : ''}`;
  bindRowLinks(body);
  if (!writable) return;
  $$('.kcard', body).forEach((c) => c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.dataset.id)));
  $$('.column', body).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      try {
        await api('PATCH', `${pid ? `/projects/${pid}` : '/company'}/modules/${mod.key}/${id}`, { status: col.dataset.status });
        toast(`Moved to ${col.dataset.status}`);
        reload();
      } catch (err) { toast(err.errors ? `${err.message}: ${Object.entries(err.errors).map(([k, v]) => `${k} ${v}`).join(', ')}` : err.message, true); }
    });
  });
}

function renderGantt(body, items, pid) {
  const acts = items.filter((a) => a.start_date && a.finish_date).sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (!acts.length) { body.innerHTML = '<div class="empty">No scheduled activities.</div>'; return; }
  const t = (s) => Date.parse(`${s}T00:00`);
  const min = Math.min(...acts.map((a) => t(a.start_date))) - 7 * 864e5;
  const max = Math.max(...acts.map((a) => t(a.finish_date))) + 14 * 864e5;
  const pct = (x) => ((x - min) / (max - min)) * 100;
  const months = [];
  for (let d = new Date(min); d.getTime() <= max; d.setMonth(d.getMonth() + 1, 1)) months.push(new Date(d.getFullYear(), d.getMonth(), 1));
  const todayPct = pct(Date.now());
  body.innerHTML = `<div class="card"><div class="gantt">
    <div class="gantt-head"><div style="padding:4px 8px">Activity</div><div class="gantt-months">${months.filter((m) => m.getTime() >= min).map((m) => `<span style="left:${pct(m.getTime())}%">${m.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}</span>`).join('')}</div></div>
    ${acts.map((a) => `<div class="gantt-row"><div class="name" data-href="#/p/${pid}/m/schedule/${a.id}" title="${esc(a.name)}">${esc(a.wbs || '')} ${esc(a.name)}</div>
      <div class="gantt-track">${todayPct > 0 && todayPct < 100 ? `<div class="gantt-today" style="left:${todayPct}%"></div>` : ''}
      <div class="gantt-bar ${a.critical ? 'critical' : ''} ${a.milestone ? 'milestone' : ''}" title="${esc(a.name)}: ${fmtDate(a.start_date)} – ${fmtDate(a.finish_date)} (${a.percent_complete || 0}%)" style="left:${pct(t(a.start_date))}%;width:${Math.max(0.6, pct(t(a.finish_date) + 864e5) - pct(t(a.start_date)))}%">${a.milestone ? '' : `<div class="fill" style="width:${a.percent_complete || 0}%"></div>`}</div></div></div>`).join('')}
  </div><div class="muted mt">Orange = critical path · Red line = today · Fill = % complete</div></div>`;
  bindRowLinks(body);
}

// ─── Form view ─────────────────────────────────────────────────────────
async function refOptions(pid, field) {
  const target = S.modules[field.module];
  if (!target || !can(target.key)) return [];
  const url = target.scope === 'project' ? `/projects/${pid}/modules/${target.key}?limit=500` : `/company/modules/${target.key}?limit=500`;
  return (await api('GET', url)).items.map((r) => ({ id: r.id, label: `${r.number} – ${r.title}` }));
}

function inputFor(field, value, refs) {
  const name = `name="${field.key}" id="f-${field.key}"`;
  switch (field.type) {
    case 'textarea': return `<textarea ${name}>${esc(value ?? '')}</textarea>`;
    case 'number': case 'currency': case 'percent':
      return `<input ${name} type="number" step="any" value="${esc(value ?? '')}" ${field.type === 'percent' ? 'min="0" max="100"' : ''}>`;
    case 'date': return `<input ${name} type="date" value="${esc(value ?? '')}">`;
    case 'datetime': return `<input ${name} type="datetime-local" value="${esc(value ? String(value).slice(0, 16) : '')}">`;
    case 'boolean': return `<label style="font-weight:400"><input ${name} type="checkbox" ${value ? 'checked' : ''}> Yes</label>`;
    case 'select': return `<select ${name}><option value=""></option>${field.options.map((o) => `<option ${value === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'user': return `<select ${name}><option value=""></option>${S.users.map((u) => `<option value="${u.id}" ${Number(value) === u.id ? 'selected' : ''}>${esc(u.name)}${u.title ? ` – ${esc(u.title)}` : ''}</option>`).join('')}</select>`;
    case 'company': return `<select ${name}><option value=""></option>${S.companies.map((c) => `<option value="${c.id}" ${Number(value) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
    case 'ref': return `<select ${name}><option value=""></option>${(refs[field.key] || []).map((o) => `<option value="${o.id}" ${Number(value) === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    case 'lines': return linesEditor(field, value || []);
    default: return `<input ${name} type="text" value="${esc(value ?? '')}">`;
  }
}

function lineCell(sub, v) {
  const n = `data-sub="${sub.key}"`;
  switch (sub.type) {
    case 'number': case 'currency': case 'percent': return `<input ${n} type="number" step="any" value="${esc(v ?? '')}">`;
    case 'date': return `<input ${n} type="date" value="${esc(v ?? '')}">`;
    case 'boolean': return `<input ${n} type="checkbox" ${v ? 'checked' : ''} style="width:auto">`;
    case 'select': return `<select ${n}><option value=""></option>${sub.options.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    default: return `<input ${n} type="text" value="${esc(v ?? '')}">`;
  }
}

function linesEditor(field, rows) {
  const row = (r = {}) => `<tr>${field.fields.map((s) => `<td>${lineCell(s, r[s.key])}</td>`).join('')}<td><button type="button" class="btn small danger" data-remove-line title="Remove">✕</button></td></tr>`;
  const hasAmount = field.fields.some((s) => s.key === 'amount');
  return `<div class="table-wrap"><table class="lines" data-lines="${field.key}"><thead><tr>${field.fields.map((s) => `<th>${esc(s.label)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${(rows.length ? rows : [{}]).map(row).join('')}</tbody></table></div>
    <div class="btn-row mt"><button type="button" class="btn small" data-add-line="${field.key}">+ Add row</button>${hasAmount ? `<span class="muted" data-lines-total="${field.key}"></span>` : ''}</div>
    <template data-line-template="${field.key}">${row()}</template>`;
}

function collectForm(form, mod) {
  const out = {};
  for (const f of mod.fields) {
    if (f.type === 'lines') {
      out[f.key] = $$(`table[data-lines="${f.key}"] tbody tr`, form).map((tr) => {
        const r = {};
        for (const s of f.fields) {
          const el = $(`[data-sub="${s.key}"]`, tr);
          if (!el) continue;
          if (s.type === 'boolean') r[s.key] = el.checked;
          else if (el.value !== '') r[s.key] = ['number', 'currency', 'percent'].includes(s.type) ? Number(el.value) : el.value;
        }
        return r;
      }).filter((r) => Object.values(r).some((v) => v !== '' && v != null && v !== false));
      continue;
    }
    const el = form.elements[f.key];
    if (!el) continue;
    if (f.type === 'boolean') out[f.key] = el.checked;
    else if (el.value === '') out[f.key] = null;
    else if (['number', 'currency', 'percent'].includes(f.type)) out[f.key] = Number(el.value);
    else if (['user', 'company', 'ref'].includes(f.type)) out[f.key] = Number(el.value);
    else out[f.key] = el.value;
  }
  return out;
}

async function viewForm(main, pid, mod, id, query = {}) {
  if (!can(mod.key, 'write')) { main.innerHTML = '<div class="empty">You do not have permission to edit this tool.</div>'; return; }
  const base = pid ? `/projects/${pid}/modules/${mod.key}` : `/company/modules/${mod.key}`;
  const hrefBase = pid ? `#/p/${pid}/m/${mod.key}` : `#/m/${mod.key}`;
  let rec = id ? await api('GET', `${base}/${id}`) : {};
  if (!id) {
    for (const f of mod.fields) if (f.default !== undefined) rec[f.key] = f.default;
    let prefill = {};
    try { prefill = JSON.parse(sessionStorage.getItem('ks_prefill') || '{}'); sessionStorage.removeItem('ks_prefill'); } catch { /* ignore */ }
    rec = { ...rec, ...prefill, ...query };
  }
  const refs = {};
  for (const f of mod.fields.filter((x) => x.type === 'ref')) refs[f.key] = await refOptions(pid, f);
  const fields = mod.fields.filter((f) => !(f.key === 'status' && !id && mod.statuses.length < 2));
  main.innerHTML = `
    <div class="page-head"><div class="title"><div class="breadcrumb"><a href="${hrefBase}">${esc(mod.label)}</a></div><h1>${id ? `Edit ${esc(mod.singular)} ${esc(rec.number)}` : `New ${esc(mod.singular)}`}</h1></div></div>
    <form class="card" id="rec-form" novalidate><div class="form-grid">
      ${fields.map((f) => `<div class="field ${['textarea', 'lines'].includes(f.type) ? 'wide' : ''}" data-key="${f.key}" ${f.showIf ? `data-showif="${esc(JSON.stringify(f.showIf))}"` : ''}>
        <label for="f-${f.key}">${esc(f.label)} ${f.required ? '<span class="req">*</span>' : ''}</label>${inputFor(f, rec[f.key], refs)}${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}<div class="err"></div></div>`).join('')}
    </div>
    <div class="form-error mt" id="form-error"></div>
    <div class="btn-row mt"><button class="btn primary" type="submit">${id ? 'Save Changes' : `Create ${esc(mod.singular)}`}</button><a class="btn" href="${id ? `${hrefBase}/${id}` : hrefBase}">Cancel</a></div></form>`;
  const form = $('#rec-form');
  const applyShowIf = () => $$('[data-showif]', form).forEach((el) => {
    const cond = JSON.parse(el.dataset.showif);
    el.classList.toggle('hidden', form.elements[cond.field]?.value !== cond.equals);
  });
  const updateTotals = () => $$('[data-lines-total]', form).forEach((el) => {
    const key = el.dataset.linesTotal;
    const rows = $$(`table[data-lines="${key}"] tbody tr`, form);
    const total = rows.reduce((s, tr) => {
      const amt = $('[data-sub="amount"]', tr);
      const q = $('[data-sub="quantity"]', tr);
      const uc = $('[data-sub="unit_cost"]', tr);
      return s + (amt?.value ? Number(amt.value) : q && uc ? Number(q.value || 0) * Number(uc.value || 0) : 0);
    }, 0);
    el.textContent = `Total: ${money2(total)}`;
  });
  form.addEventListener('change', () => { applyShowIf(); updateTotals(); });
  form.addEventListener('input', updateTotals);
  form.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add-line]');
    if (add) {
      const key = add.dataset.addLine;
      $(`table[data-lines="${key}"] tbody`, form).insertAdjacentHTML('beforeend', $(`template[data-line-template="${key}"]`, form).innerHTML);
    }
    const rm = e.target.closest('[data-remove-line]');
    if (rm) { rm.closest('tr').remove(); updateTotals(); }
  });
  applyShowIf();
  updateTotals();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $$('.field', form).forEach((f) => { f.classList.remove('invalid'); $('.err', f).textContent = ''; });
    $('#form-error').textContent = '';
    const body = collectForm(form, mod);
    try {
      const saved = id ? await api('PATCH', `${base}/${id}`, body) : await api('POST', base, body);
      if (mod.key === 'directory') await refreshLookups();
      toast(`${mod.singular} ${saved.number} saved`);
      location.hash = `${hrefBase}/${saved.id}`;
    } catch (err) {
      $('#form-error').textContent = err.message;
      for (const [k, msg] of Object.entries(err.errors || {})) {
        const field = $(`.field[data-key="${k.split('[')[0]}"]`, form);
        if (field) { field.classList.add('invalid'); $('.err', field).textContent = `${k.includes('[') ? k + ' ' : ''}${msg}`; }
      }
    }
  });
}

// ─── Detail view ───────────────────────────────────────────────────────
function detailValue(field, v, pid) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '<span class="muted">—</span>';
  switch (field.type) {
    case 'currency': return money2(v);
    case 'percent': return `${v}%`;
    case 'date': return fmtDate(v);
    case 'datetime': return fmtDateTime(v);
    case 'boolean': return v ? 'Yes' : 'No';
    case 'user': return esc(userName(v));
    case 'company': return `<a href="#/m/directory/${v}">${esc(companyName(v))}</a>`;
    case 'ref': return `<a href="${recordHref(field.module, v, pid)}" data-ref="${v}">${esc(S.modules[field.module]?.singular || '')} #${v}</a>`;
    case 'select': return field.key === 'status' ? pill(v) : esc(v);
    case 'lines': {
      const hasAmount = field.fields.some((s) => s.key === 'amount');
      const total = hasAmount ? v.reduce((s, r) => s + (Number(r.amount) || 0), 0) : 0;
      return `<div class="table-wrap"><table><thead><tr>${field.fields.map((s) => `<th class="${['currency', 'number', 'percent'].includes(s.type) ? 'num' : ''}">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>
        ${v.map((r) => `<tr>${field.fields.map((s) => `<td class="${['currency', 'number', 'percent'].includes(s.type) ? 'num' : ''}">${s.type === 'currency' ? money2(r[s.key]) : s.type === 'boolean' ? (r[s.key] ? '✓' : '') : s.type === 'date' ? fmtDate(r[s.key]) : esc(r[s.key] ?? '')}</td>`).join('')}</tr>`).join('')}
        ${hasAmount ? `<tr class="total">${field.fields.map((s) => `<td class="num">${s.key === 'amount' ? money2(total) : ''}</td>`).join('')}</tr>` : ''}</tbody></table></div>`;
    }
    default: return esc(v);
  }
}

function computedCards(rec) {
  const c = rec.computed;
  if (!c) return '';
  const entries = Object.entries(c).filter(([, v]) => v != null);
  if (!entries.length) return '';
  const moneyKeys = /value|amount|change|invoiced|paid|retainage|balance|total|subtotal|markup|bid|spread|cost|gross|net/;
  return `<div class="grid cols-4 kpis" style="margin-bottom:16px">${entries.map(([k, v]) => kpi(labelize(k), k.startsWith('percent') ? `${v}%` : typeof v === 'number' && moneyKeys.test(k) && !/count|items|bids_received|steps|completed|workers|hours|passed|failed|applicable/.test(k) ? money(v) : num(v))).join('')}</div>`;
}

async function viewDetail(main, pid, mod, id, guard) {
  const base = pid ? `/projects/${pid}/modules/${mod.key}` : `/company/modules/${mod.key}`;
  const hrefBase = pid ? `#/p/${pid}/m/${mod.key}` : `#/m/${mod.key}`;
  const rec = await api('GET', `${base}/${id}`);
  if (!guard()) return;
  const writable = can(mod.key, 'write');
  const scalar = mod.fields.filter((f) => f.type !== 'lines' && f.type !== 'textarea' && (!f.showIf || rec[f.showIf.field] === f.showIf.equals));
  const long = mod.fields.filter((f) => f.type === 'textarea' || f.type === 'lines');
  const actions = workflowActions(mod, rec, pid);
  main.innerHTML = `
    <div class="page-head"><div class="title"><div class="breadcrumb"><a href="${hrefBase}">${esc(mod.label)}</a> / ${esc(rec.number)}</div>
      <h1>${esc(mod.singular)} ${esc(rec.number)}: ${esc(rec.title)}</h1>
      <div class="sub">${pill(rec.status)} ${rec.overdue ? '<span class="overdue">Overdue</span> · ' : ''}Created ${fmtDateTime(rec.created_at)} by ${esc(userName(rec.created_by) || 'system')} · Updated ${fmtDateTime(rec.updated_at)}</div></div>
      <div class="btn-row no-print">
        ${writable && mod.statuses.length > 1 ? `<select id="status-change" class="btn" aria-label="Change status">${mod.statuses.map((s) => `<option ${s === rec.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
        ${actions.map((a, i) => `<button class="btn" data-action="${i}">${a.label}</button>`).join('')}
        ${writable ? `<a class="btn" href="${hrefBase}/${id}/edit">✎ Edit</a>` : ''}
        <button class="btn" onclick="window.print()">🖨 Print</button>
        ${writable ? '<button class="btn danger" id="delete">🗑 Delete</button>' : ''}
      </div></div>
    ${computedCards(rec)}
    <div class="tabs no-print" id="tabs"><button class="on" data-tab="general">General</button><button data-tab="related">Related</button><button data-tab="files">Attachments</button><button data-tab="comments">Comments</button><button data-tab="activity">Change History</button></div>
    <div id="tab-general">
      <div class="card"><div class="detail-grid">${scalar.map((f) => `<div><div class="k">${esc(f.label)}</div><div class="v">${detailValue(f, rec[f.key], pid)}</div></div>`).join('')}</div></div>
      ${long.map((f) => `<div class="card"><h3>${esc(f.label)}</h3><div class="v" style="white-space:pre-wrap">${detailValue(f, rec[f.key], pid)}</div></div>`).join('')}
    </div>
    <div id="tab-related" class="hidden"></div><div id="tab-files" class="hidden"></div><div id="tab-comments" class="hidden"></div><div id="tab-activity" class="hidden"></div>`;

  // Resolve ref labels.
  $$('[data-ref]', main).forEach(async (a) => {
    try { const r = await api('GET', `/records/${a.dataset.ref}`); a.textContent = `${r.number} – ${r.title}`; } catch { /* no access */ }
  });

  $('#status-change')?.addEventListener('change', async (e) => {
    try { await api('PATCH', `${base}/${id}`, { status: e.target.value }); toast(`Status set to ${e.target.value}`); route(); } catch (err) {
      toast(err.errors ? `Cannot change status – ${Object.entries(err.errors).map(([k, v]) => `${labelize(k)} ${v}`).join('; ')}` : err.message, true);
      e.target.value = rec.status;
    }
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${mod.singular} ${rec.number}? This cannot be undone.`)) return;
    await api('DELETE', `${base}/${id}`);
    if (mod.key === 'directory') await refreshLookups();
    toast('Deleted');
    location.hash = hrefBase;
  });
  $$('[data-action]', main).forEach((b) => b.addEventListener('click', () => actions[Number(b.dataset.action)].run()));

  const loaded = {};
  $$('#tabs button').forEach((b) => b.addEventListener('click', async () => {
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    for (const t of ['general', 'related', 'files', 'comments', 'activity']) $(`#tab-${t}`).classList.toggle('hidden', t !== b.dataset.tab);
    if (loaded[b.dataset.tab]) return;
    loaded[b.dataset.tab] = true;
    const el = $(`#tab-${b.dataset.tab}`);
    if (b.dataset.tab === 'files') renderFiles(el, rec);
    if (b.dataset.tab === 'comments') renderComments(el, rec);
    if (b.dataset.tab === 'activity') renderHistory(el, rec, mod);
    if (b.dataset.tab === 'related') renderRelated(el, rec, mod, pid);
  }));
}

/** Procore-style workflow shortcuts that pre-fill a new record from the current one. */
function workflowActions(mod, rec, pid) {
  const go = (target, data) => { sessionStorage.setItem('ks_prefill', JSON.stringify(data)); location.hash = `#/p/${pid}/m/${target}/new`; };
  const out = [];
  if (!pid) return out;
  if (mod.key === 'rfis' && can('change_events', 'write')) out.push({ label: '⚡ Create Change Event', run: () => go('change_events', { title: `From ${rec.number}: ${rec.subject}`, origin_rfi: rec.id, description: rec.question, scope: 'TBD', line_items: rec.cost_impact_amount ? [{ description: rec.subject, amount: rec.cost_impact_amount }] : [] }) });
  if (mod.key === 'change_events' && can('change_orders', 'write')) out.push({ label: '🔁 Create Prime PCO', run: () => go('change_orders', { title: rec.title, contract_kind: 'Prime Contract', change_event: rec.id, line_items: rec.line_items, description: rec.description }) });
  if (mod.key === 'observations' && can('punch_list', 'write')) out.push({ label: '📌 Create Punch Item', run: () => go('punch_list', { title: rec.title, location: rec.location, responsible_company: rec.responsible_company, assignee: rec.assignee, due_date: rec.due_date, priority: rec.priority, description: rec.description }) });
  if (mod.key === 'inspections' && can('observations', 'write') && (rec.checklist || []).some((c) => c.result === 'Fail')) out.push({ label: '👁 Observation from Failures', run: () => go('observations', { title: `Failed items – ${rec.title}`, observation_type: rec.inspection_type === 'Safety' ? 'Safety' : 'Quality', location: rec.location, description: rec.checklist.filter((c) => c.result === 'Fail').map((c) => `• ${c.item}${c.notes ? ` – ${c.notes}` : ''}`).join('\n') }) });
  if (mod.key === 'bid_packages' && can('commitments', 'write')) {
    const low = (rec.bidders || []).filter((b) => b.amount).sort((a, b) => a.amount - b.amount)[0];
    if (low) out.push({ label: '🤝 Award → Commitment', run: () => { const vendor = S.companies.find((c) => c.name.toLowerCase() === String(low.company).toLowerCase()); go('commitments', { title: rec.title, commitment_type: 'Subcontract', vendor: vendor?.id, line_items: [{ description: `${rec.title} – ${low.company}`, amount: low.amount }], scope: rec.scope }); } });
  }
  if ((mod.key === 'commitments' || mod.key === 'prime_contracts') && can('invoices', 'write')) out.push({ label: '🧾 New Invoice', run: () => go('invoices', { title: `${rec.title} – Pay App`, contract_kind: mod.key === 'commitments' ? 'Commitment' : 'Prime Contract', [mod.key === 'commitments' ? 'commitment' : 'prime_contract']: rec.id, retainage_percent: rec.retainage_percent, line_items: (rec.line_items || []).map((l) => ({ cost_code: l.cost_code, description: l.description, percent_complete: 0 })) }) });
  if ((mod.key === 'commitments' || mod.key === 'prime_contracts') && can('change_orders', 'write')) out.push({ label: '🔁 New Change Order', run: () => go('change_orders', { title: `${rec.title} – CO`, contract_kind: mod.key === 'commitments' ? 'Commitment' : 'Prime Contract', [mod.key === 'commitments' ? 'commitment' : 'prime_contract']: rec.id }) });
  if (mod.key === 'meetings' && can('tasks', 'write') && (rec.items || []).some((i) => i.status !== 'Closed')) out.push({ label: '✅ Tasks from Action Items', run: async () => {
    const open = rec.items.filter((i) => i.status !== 'Closed' && i.topic);
    for (const i of open) await api('POST', `/projects/${pid}/modules/tasks`, { title: `${rec.number}: ${i.topic}`, description: i.discussion, due_date: i.due, category: 'General' });
    toast(`Created ${open.length} task(s)`);
  } });
  return out;
}

async function renderRelated(el, rec, mod, pid) {
  el.innerHTML = '<div class="empty">Loading…</div>';
  const sections = [];
  const q = async (m, filterKey) => (pid && can(m) ? (await api('GET', `/projects/${pid}/modules/${m}?filter[${filterKey}]=${rec.id}`)).items : []);
  if (mod.key === 'prime_contracts' || mod.key === 'commitments') {
    const key = mod.key === 'prime_contracts' ? 'prime_contract' : 'commitment';
    sections.push(['Change Orders', 'change_orders', await q('change_orders', key)], ['Invoices', 'invoices', await q('invoices', key)]);
  }
  if (mod.key === 'change_events') sections.push(['Change Orders', 'change_orders', await q('change_orders', 'change_event')]);
  if (mod.key === 'rfis') sections.push(['Change Events', 'change_events', await q('change_events', 'origin_rfi')]);
  if (mod.key === 'directory' && pid == null) {
    for (const p of S.projects) {
      for (const m of ['commitments', 'punch_list', 'submittals']) {
        if (!can(m)) continue;
        const f = m === 'commitments' ? 'vendor' : 'responsible_company';
        const items = (await api('GET', `/projects/${p.id}/modules/${m}?filter[${f}]=${rec.id}`)).items;
        if (items.length) sections.push([`${S.modules[m].label} – ${p.name}`, m, items]);
      }
    }
  }
  const links = await api('GET', `/records/${rec.id}/links`).catch(() => []);
  el.innerHTML = sections.map(([title, m, items]) => `<div class="card"><h3>${esc(title)} (${items.length})</h3>${items.length ? `<div class="table-wrap"><table><tbody>${items.map((r) => `<tr class="click" data-href="${recordHref(m, r, r.project_id)}"><td class="nowrap">${esc(r.number)}</td><td>${esc(r.title)}</td><td>${pill(r.status)}</td><td class="num">${r.computed?.total != null ? money(r.computed.total) : r.computed?.gross_amount != null ? money(r.computed.gross_amount) : r.computed?.revised_contract_value != null ? money(r.computed.revised_contract_value) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">None</div>'}</div>`).join('')
    + `<div class="card"><h3>Linked External Records</h3>${links.length ? `<div class="table-wrap"><table><thead><tr><th>Connection</th><th>Remote Entity</th><th>Remote ID</th><th>Last Synced</th></tr></thead><tbody>${links.map((l) => `<tr><td>${isAdmin() ? `<a href="#/integrations/${l.connection_id}">${esc(l.connection)}</a>` : esc(l.connection)}</td><td>${esc(l.remote_entity)}</td><td><code>${esc(l.remote_id)}</code></td><td>${fmtDateTime(l.updated_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">This record is not linked to any external system.</div>'}</div>`;
  bindRowLinks(el);
}

async function renderFiles(el, rec) {
  const files = await api('GET', `/records/${rec.id}/files`);
  el.innerHTML = `<div class="card"><label class="dropzone" id="drop">📎 Drop files here or click to upload<input type="file" id="file-input" multiple hidden></label>
    <div class="files">${files.map((f) => `<div class="file">${/^image\//.test(f.mime) ? `<img src="/api/files/${f.id}?inline=1&access_token=${encodeURIComponent(S.token)}" alt="${esc(f.name)}" loading="lazy">` : '<div style="font-size:30px">📄</div>'}
      <a href="#" data-dl="${f.id}" data-name="${esc(f.name)}">${esc(f.name)}</a><div class="muted">${(f.size / 1024).toFixed(1)} KB · ${esc(f.uploaded_by || '')}</div>
      ${can(rec.module, 'write') ? `<button class="btn small danger mt" data-del="${f.id}">Remove</button>` : ''}</div>`).join('') || '<div class="muted">No attachments yet.</div>'}</div></div>`;
  const upload = async (list) => {
    for (const file of list) {
      try {
        await api('POST', `/records/${rec.id}/files`, file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } });
      } catch (err) { toast(`${file.name}: ${err.message}`, true); }
    }
    toast('Upload complete');
    renderFiles(el, rec);
  };
  const drop = $('#drop', el);
  $('#file-input', el).addEventListener('change', (e) => upload([...e.target.files]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); upload([...e.dataTransfer.files]); });
  $$('[data-dl]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); download(`/files/${a.dataset.dl}`, a.dataset.name); }));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => { if (confirm('Remove this file?')) { await api('DELETE', `/files/${b.dataset.del}`); renderFiles(el, rec); } }));
}

async function renderComments(el, rec) {
  const comments = await api('GET', `/records/${rec.id}/comments`);
  el.innerHTML = `<div class="card">${comments.map((c) => `<div class="comment"><div class="meta"><strong>${esc(c.author || 'Unknown')}</strong> · ${fmtDateTime(c.created_at)}</div><div style="white-space:pre-wrap">${esc(c.body).replace(/@([\w.]+)/g, '<strong>@$1</strong>')}</div></div>`).join('') || '<div class="muted">No comments yet.</div>'}
    <form id="cform" class="mt"><div class="field"><textarea name="body" placeholder="Add a comment… use @name to mention a teammate" required></textarea></div><button class="btn primary mt">Post Comment</button></form></div>`;
  $('#cform', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', `/records/${rec.id}/comments`, { body: e.target.body.value }); renderComments(el, rec); } catch (err) { toast(err.message, true); }
  });
}

async function renderHistory(el, rec, mod) {
  const items = await api('GET', `/records/${rec.id}/activity`);
  const fmt = (k, v) => {
    const f = mod.fields.find((x) => x.key === k);
    if (v == null || v === '') return '—';
    if (f?.type === 'lines') return `${v.length} row(s)`;
    if (f?.type === 'user') return userName(v);
    if (f?.type === 'company') return companyName(v);
    if (f?.type === 'currency') return money2(v);
    return String(v).slice(0, 120);
  };
  el.innerHTML = `<div class="card">${items.map((a) => `<div class="activity"><div><strong>${esc(a.summary || a.action)}</strong></div><div class="meta">${esc(a.actor)} · ${fmtDateTime(a.ts)}</div>
    ${a.changes ? `<div class="mt">${Object.entries(a.changes).map(([k, c]) => `<div style="font-size:13px"><span class="muted">${esc(mod.fields.find((f) => f.key === k)?.label || k)}:</span> ${esc(fmt(k, c.from))} → <strong>${esc(fmt(k, c.to))}</strong></div>`).join('')}</div>` : ''}</div>`).join('') || '<div class="muted">No history.</div>'}</div>`;
}

// ─── Budget ────────────────────────────────────────────────────────────
async function viewBudget(main, pid, guard) {
  const data = await api('GET', `/projects/${pid}/budget`);
  if (!guard()) return;
  const cols = [
    ['original_budget', 'Original Budget'], ['budget_modifications', 'Budget Mods'], ['approved_changes', 'Approved COs'], ['revised_budget', 'Revised Budget'],
    ['pending_budget_changes', 'Pending Budget Changes'], ['projected_budget', 'Projected Budget'], ['committed_costs', 'Committed Costs'], ['direct_costs', 'Direct Costs'],
    ['job_to_date_costs', 'Job to Date Costs'], ['pending_cost_changes', 'Pending Cost Changes'], ['projected_costs', 'Projected Costs'], ['forecast_to_complete', 'Forecast to Complete'],
    ['estimated_cost_at_completion', 'Est. Cost at Completion'], ['projected_over_under', 'Projected Over/Under'],
  ];
  const s = data.summary;
  main.innerHTML = `
    <div class="page-head"><div class="title"><h1>📊 Budget</h1><div class="sub">All columns are calculated live from budget lines, prime contract & commitment change orders, direct costs and subcontractor invoices.</div></div>
      <div class="btn-row"><button class="btn" id="bexport">⬇ Export CSV</button>${can('budget', 'write') ? `<a class="btn primary" href="#/p/${pid}/m/budget/new">+ Budget Line</a>` : ''}</div></div>
    <div class="grid cols-4 kpis" style="margin-bottom:16px">${kpi('Revised Budget', money(data.totals.revised_budget))}${kpi('Committed Costs', money(data.totals.committed_costs))}${kpi('Projected Costs', money(data.totals.projected_costs))}${kpi('Projected Over/Under', money(data.totals.projected_over_under), data.totals.projected_over_under < 0 ? 'bad' : 'ok')}</div>
    <div class="grid cols-4 kpis" style="margin-bottom:16px">${kpi('Revised Prime Contract', money(s.revised_prime_contract))}${kpi('Billed to Owner', money(s.prime_invoiced))}${kpi('Pending Prime Changes', money(s.pending_prime_changes))}${kpi('Projected Margin', money(s.projected_margin), s.projected_margin < 0 ? 'bad' : 'ok')}</div>
    <div class="table-wrap"><table><thead><tr><th>Cost Code</th><th>Description</th>${cols.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>
      ${data.lines.map((l) => `<tr class="${l.budget_line_id ? 'click' : ''}" ${l.budget_line_id ? `data-href="#/p/${pid}/m/budget/${l.budget_line_id}"` : ''}><td class="nowrap"><strong>${esc(l.cost_code)}</strong>${l.unbudgeted ? ' <span class="tag" title="Costs exist without a budget line">Unbudgeted</span>' : ''}</td><td>${esc(l.description || '')}</td>
        ${cols.map(([k]) => `<td class="num ${l[k] < 0 ? 'neg' : ''}">${money(l[k])}</td>`).join('')}</tr>`).join('')}
      <tr class="total"><td colspan="2">Grand Total</td>${cols.map(([k]) => `<td class="num ${data.totals[k] < 0 ? 'neg' : ''}">${money(data.totals[k])}</td>`).join('')}</tr>
    </tbody></table></div>`;
  bindRowLinks(main);
  $('#bexport').addEventListener('click', () => downloadText(toCSV(data.lines.map((l) => ({ cost_code: l.cost_code, description: l.description, ...Object.fromEntries(cols.map(([k]) => [k, l[k]])) }))), `budget-${today()}.csv`));
}

// ─── Reports ───────────────────────────────────────────────────────────
const REPORTS = [
  ['open-items', 'Open Items by Tool', 'Counts of open and overdue items for every tool.'],
  ['overdue-by-assignee', 'Overdue by Assignee', 'Who is holding overdue RFIs, submittals, punch items, and more.'],
  ['rfi-log', 'RFI Log', 'Every RFI with ball-in-court, days open and impacts.'],
  ['submittal-log', 'Submittal Log', 'Submittal register with lead times and required-on-site dates.'],
  ['safety', 'Safety Summary', 'Incidents, recordables, near misses and TRIR.'],
  ['manpower', 'Manpower by Company', 'Workers and man-hours reported on daily logs.'],
  ['commitments', 'Commitments Summary', 'Subcontract & PO values, change orders and billing.'],
  ['change-orders', 'Change Order Log', 'All change orders with contract, status and amount.'],
];

async function viewReports(main, pid, key, guard) {
  if (!key) {
    main.innerHTML = `<div class="page-head"><div class="title"><h1>📈 Reports</h1></div></div><div class="grid cols-3">${REPORTS.map(([k, t, d]) => `<a class="card" href="#/p/${pid}/reports/${k}" style="color:inherit"><h3>${esc(t)}</h3><div class="muted">${esc(d)}</div></a>`).join('')}</div>`;
    return;
  }
  const r = await api('GET', `/projects/${pid}/reports/${key}`);
  if (!guard()) return;
  const cols = r.rows.length ? Object.keys(r.rows[0]) : [];
  const isMoney = (k) => /original|approved|revised|invoiced|remaining|amount/.test(k);
  main.innerHTML = `<div class="page-head"><div class="title"><div class="breadcrumb"><a href="#/p/${pid}/reports">Reports</a></div><h1>${esc(r.title)}</h1></div><div class="btn-row"><button class="btn" id="rexport">⬇ Export CSV</button><button class="btn" onclick="window.print()">🖨 Print</button></div></div>
    ${r.summary ? `<div class="grid cols-4 kpis" style="margin-bottom:16px">${Object.entries(r.summary).map(([k, v]) => kpi(labelize(k), v == null ? '—' : num(v))).join('')}</div>` : ''}
    <div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(labelize(c))}</th>`).join('')}</tr></thead><tbody>${r.rows.map((row) => `<tr>${cols.map((c) => `<td class="${typeof row[c] === 'number' ? 'num' : ''}">${typeof row[c] === 'number' && isMoney(c) ? money(row[c]) : /date|occurred/.test(c) ? fmtDate(row[c]) : esc(row[c] ?? '')}</td>`).join('')}</tr>`).join('') || '<tr><td class="empty">No data</td></tr>'}</tbody></table></div>`;
  $('#rexport').addEventListener('click', () => downloadText(toCSV(r.rows), `${key}-${today()}.csv`));
}

// ─── Team & project settings ──────────────────────────────────────────
async function viewTeam(main, pid, guard) {
  const members = await api('GET', `/projects/${pid}/members`);
  if (!guard()) return;
  const manage = ['admin', 'manager'].includes(S.me.role);
  const others = S.users.filter((u) => !members.some((m) => m.id === u.id));
  main.innerHTML = `<div class="page-head"><div class="title"><h1>👷 Project Team</h1><div class="sub">Members can access this project according to their role permissions.</div></div></div>
    ${manage && others.length ? `<div class="card toolbar"><select id="add-user">${others.map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(S.meta.roles[u.role])})</option>`).join('')}</select><button class="btn primary" id="add-btn">Add to Project</button></div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
    ${members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.title || '')}</td><td><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></td><td>${esc(S.meta.roles[m.role])}</td><td>${manage ? `<button class="btn small danger" data-rm="${m.id}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  $('#add-btn')?.addEventListener('click', async () => { await api('POST', `/projects/${pid}/members`, { user_id: Number($('#add-user').value) }); route(); });
  $$('[data-rm]', main).forEach((b) => b.addEventListener('click', async () => { await api('DELETE', `/projects/${pid}/members/${b.dataset.rm}`); route(); }));
}

async function viewProjectSettings(main, pid) {
  const p = await api('GET', `/projects/${pid}`);
  main.innerHTML = `<div class="page-head"><div class="title"><h1>⚙️ Project Settings</h1></div></div>
    <div class="card"><h2>${esc(p.name)}</h2><div class="btn-row"><button class="btn primary" id="edit-p">Edit Project Details</button>
    <button class="btn" id="toggle-active">${p.active ? 'Mark Inactive' : 'Mark Active'}</button>${isAdmin() ? '<button class="btn danger" id="del-p">Delete Project</button>' : ''}</div></div>`;
  $('#edit-p').addEventListener('click', () => projectModal(p));
  $('#toggle-active').addEventListener('click', async () => { await api('PATCH', `/projects/${pid}`, { active: !p.active }); await refreshLookups(); route(); });
  $('#del-p')?.addEventListener('click', async () => {
    if (prompt(`Type the project name to permanently delete it:\n${p.name}`) !== p.name) return;
    await api('DELETE', `/projects/${pid}`);
    await refreshLookups();
    location.hash = '#/';
  });
}

// ─── Integrations ──────────────────────────────────────────────────────
async function viewIntegrations(main, guard) {
  const conns = await api('GET', '/integrations/connections');
  if (!guard()) return;
  const cats = {};
  for (const a of S.meta.adapters) (cats[a.category] = cats[a.category] || []).push(a);
  main.innerHTML = `
    <div class="page-head"><div class="title"><h1>🔌 Integrations</h1><div class="sub">Link accounting/ERP, scheduling, design, e-signature and messaging systems. Every connection supports field mapping, pull/push sync, realtime push, scheduled sync and signed inbound webhooks.</div></div></div>
    <div class="card"><h2>Active Connections</h2>${conns.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>System</th><th>Scope</th><th>Mode</th><th>Sync</th><th>Last Sync</th><th>Status</th></tr></thead><tbody>
      ${conns.map((c) => `<tr class="click" data-href="#/integrations/${c.id}"><td><strong>${esc(c.name)}</strong></td><td>${esc(c.adapter_name)}</td><td>${c.project_id ? esc(S.projects.find((p) => p.id === c.project_id)?.name || `Project ${c.project_id}`) : 'All projects'}</td>
      <td>${c.sandbox ? '<span class="pill s-draft">Sandbox</span>' : '<span class="pill s-active">Live</span>'}</td><td>${[c.realtime ? 'Realtime' : '', c.schedule_minutes ? `Every ${c.schedule_minutes} min` : ''].filter(Boolean).join(', ') || 'Manual'}</td>
      <td>${fmtDateTime(c.last_sync_at) || '—'}</td><td>${!c.enabled ? pill('Disabled') : c.state.last_error ? `<span class="pill s-failed" title="${esc(c.state.last_error)}">Error</span>` : pill('Active')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">No connections yet – pick a system below.</div>'}</div>
    ${Object.entries(cats).map(([cat, list]) => `<h2 class="mt">${esc(cat)}</h2><div class="grid cols-3">${list.map((a) => `<div class="card adapter-card"><div class="cat">${esc(a.category)}</div><h3>${esc(a.name)}</h3><p>${esc(a.description)}</p>
      <div class="muted" style="font-size:12px">${a.entities.map((e) => esc(e.label)).join(' · ') || (a.notifier ? 'Event notifications' : 'Custom entities')}</div>
      <div class="btn-row mt"><a class="btn primary small" href="#/integrations/new/${a.key}">Connect</a>${a.docsUrl ? `<a class="btn small" href="${esc(a.docsUrl)}" target="_blank" rel="noopener">API docs ↗</a>` : ''}${a.supportsSandbox ? '<span class="tag">Sandbox available</span>' : ''}</div></div>`).join('')}</div>`).join('')}`;
  bindRowLinks(main);
}

function configFieldsHtml(schema, config) {
  return schema.map((f) => {
    const v = config?.[f.key] ?? f.default;
    let input;
    if (f.type === 'boolean') input = `<label style="font-weight:400"><input type="checkbox" name="cfg_${f.key}" ${v ? 'checked' : ''}> Enabled</label>`;
    else if (f.type === 'select') input = `<select name="cfg_${f.key}">${f.options.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'textarea') input = `<textarea name="cfg_${f.key}">${esc(v ?? '')}</textarea>`;
    else if (f.type === 'json') input = `<textarea name="cfg_${f.key}" style="font-family:monospace;min-height:140px">${esc(v ? JSON.stringify(v, null, 2) : '')}</textarea>`;
    else input = `<input name="cfg_${f.key}" type="${f.secret ? 'password' : 'text'}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
    return `<div class="field ${['json', 'textarea'].includes(f.type) || f.type === 'boolean' ? 'wide' : ''}" ${f.showIf ? `data-cfg-showif="${esc(JSON.stringify(f.showIf))}"` : ''}><label>${esc(f.label)} ${f.required ? '<span class="req">*</span>' : ''}</label>${input}${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
  }).join('');
}

function readConfig(form, schema) {
  const out = {};
  for (const f of schema) {
    const el = form.elements[`cfg_${f.key}`];
    if (!el) continue;
    out[f.key] = f.type === 'boolean' ? el.checked : el.value;
  }
  return out;
}

function bindCfgShowIf(form) {
  const apply = () => $$('[data-cfg-showif]', form).forEach((el) => {
    const c = JSON.parse(el.dataset.cfgShowif);
    el.classList.toggle('hidden', form.elements[`cfg_${c.field}`]?.value !== c.equals);
  });
  form.addEventListener('change', apply);
  apply();
}

async function viewNewConnection(main, adapterKey) {
  const a = S.meta.adapters.find((x) => x.key === adapterKey);
  if (!a) { main.innerHTML = '<div class="empty">Unknown system.</div>'; return; }
  main.innerHTML = `<div class="page-head"><div class="title"><div class="breadcrumb"><a href="#/integrations">Integrations</a></div><h1>Connect ${esc(a.name)}</h1><div class="sub">${esc(a.description)}</div></div></div>
    <form class="card" id="cform"><div class="form-grid">
      <div class="field"><label>Connection Name</label><input name="name" value="${esc(a.name)}"></div>
      <div class="field"><label>Project Scope</label><select name="project_id"><option value="">All projects</option>${S.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><div class="help">Required when importing project-level records (RFIs, schedule, etc.).</div></div>
      ${configFieldsHtml(a.configSchema, {})}
    </div>${a.supportsSandbox ? '<p class="muted">Tip: keep <strong>Sandbox mode</strong> on to try the full sync flow against a simulated system before entering real credentials.</p>' : ''}
    <div class="form-error" id="cerr"></div><div class="btn-row mt"><button class="btn primary">Create Connection</button><a class="btn" href="#/integrations">Cancel</a></div></form>`;
  const form = $('#cform');
  bindCfgShowIf(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await api('POST', '/integrations/connections', { adapter: a.key, name: form.elements.name.value, project_id: Number(form.elements.project_id.value) || null, config: readConfig(form, a.configSchema) });
      toast('Connection created');
      location.hash = `#/integrations/${c.id}`;
    } catch (err) { $('#cerr').textContent = err.errors ? Object.entries(err.errors).map(([k, v]) => `${k} ${v}`).join('; ') : err.message; }
  });
}

async function viewConnection(main, id, guard) {
  const c = await api('GET', `/integrations/connections/${id}`);
  if (!guard()) return;
  const a = S.meta.adapters.find((x) => x.key === c.adapter);
  const jobsHtml = (jobs) => (jobs.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Started</th><th>Trigger</th><th>Direction</th><th>Status</th><th class="num">Pulled</th><th class="num">Created</th><th class="num">Updated</th><th class="num">Pushed</th><th class="num">Skipped</th><th class="num">Failed</th></tr></thead><tbody>
    ${jobs.map((j) => `<tr class="click" data-job="${j.id}"><td>${j.id}</td><td>${fmtDateTime(j.started_at)}</td><td>${esc(j.trigger)}</td><td>${esc(j.direction)}</td><td>${pill(j.status)}</td>${['pulled', 'created', 'updated', 'pushed', 'skipped', 'failed'].map((k) => `<td class="num">${j.stats[k] ?? 0}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="muted">No sync jobs yet.</div>');
  main.innerHTML = `
    <div class="page-head"><div class="title"><div class="breadcrumb"><a href="#/integrations">Integrations</a></div><h1>${esc(c.name)}</h1>
      <div class="sub">${esc(a?.name || c.adapter)} · ${c.sandbox ? '<span class="pill s-draft">Sandbox</span>' : '<span class="pill s-active">Live</span>'} · ${c.enabled ? pill('Enabled') : pill('Disabled')}${c.state.last_error ? ` · <span class="overdue">Last error: ${esc(c.state.last_error)}</span>` : ''}</div></div>
      <div class="btn-row"><button class="btn" id="test">🩺 Test</button>${a?.capabilities.includes('pull') || c.sandbox ? '<button class="btn" data-sync="pull">⬇ Pull</button>' : ''}${a?.capabilities.includes('push') || c.sandbox ? '<button class="btn" data-sync="push">⬆ Push</button>' : ''}${c.mappings.length ? '<button class="btn primary" data-sync="both">⇅ Sync Now</button>' : ''}<button class="btn danger" id="cdel">Delete</button></div></div>
    <div class="tabs" id="ctabs"><button class="on" data-tab="settings">Settings</button><button data-tab="mappings">Field Mappings (${c.mappings.length})</button><button data-tab="jobs">Sync History</button><button data-tab="inbound">Inbound Webhook</button>${c.sandbox ? '<button data-tab="sandbox">Sandbox Data</button>' : ''}</div>
    <div id="ct-settings"><form class="card" id="sform"><div class="form-grid">
      <div class="field"><label>Name</label><input name="name" value="${esc(c.name)}"></div>
      <div class="field"><label>Project Scope</label><select name="project_id"><option value="">All projects</option>${S.projects.map((p) => `<option value="${p.id}" ${p.id === c.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Enabled</label><label style="font-weight:400"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> Connection active</label></div>
      <div class="field"><label>Realtime Push</label><label style="font-weight:400"><input type="checkbox" name="realtime" ${c.realtime ? 'checked' : ''}> Push records to ${esc(a?.name || '')} as soon as they change</label></div>
      <div class="field"><label>Scheduled Sync (minutes, 0 = off)</label><input type="number" min="0" name="schedule_minutes" value="${c.schedule_minutes}"></div>
      ${a ? configFieldsHtml(a.configSchema, c.config) : ''}
    </div><div class="form-error" id="serr"></div><button class="btn primary mt">Save Settings</button></form></div>
    <div id="ct-mappings" class="hidden"></div>
    <div id="ct-jobs" class="hidden"><div class="card"><h2>Sync History</h2><div id="jobs">${jobsHtml(c.jobs)}</div><div id="job-log"></div></div></div>
    <div id="ct-inbound" class="hidden"></div>
    <div id="ct-sandbox" class="hidden"></div>`;

  $$('#ctabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#ctabs button').forEach((x) => x.classList.toggle('on', x === b));
    for (const t of ['settings', 'mappings', 'jobs', 'inbound', 'sandbox']) $(`#ct-${t}`)?.classList.toggle('hidden', t !== b.dataset.tab);
    if (b.dataset.tab === 'inbound') renderInbound($('#ct-inbound'), c);
    if (b.dataset.tab === 'sandbox') renderSandbox($('#ct-sandbox'), c, a);
  }));
  const sform = $('#sform');
  bindCfgShowIf(sform);
  sform.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/integrations/connections/${id}`, {
        name: sform.elements.name.value, project_id: Number(sform.elements.project_id.value) || null, enabled: sform.elements.enabled.checked,
        realtime: sform.elements.realtime.checked, schedule_minutes: Number(sform.elements.schedule_minutes.value) || 0, config: a ? readConfig(sform, a.configSchema) : undefined,
      });
      toast('Settings saved');
      route();
    } catch (err) { $('#serr').textContent = err.errors ? Object.entries(err.errors).map(([k, v]) => `${k} ${v}`).join('; ') : err.message; }
  });
  $('#test').addEventListener('click', async () => { const r = await api('POST', `/integrations/connections/${id}/test`); toast(r.message, !r.ok); });
  $('#cdel').addEventListener('click', async () => { if (confirm('Delete this connection and its sync history?')) { await api('DELETE', `/integrations/connections/${id}`); location.hash = '#/integrations'; } });
  $$('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const job = await api('POST', `/integrations/connections/${id}/sync`, { direction: b.dataset.sync });
      toast(`Sync ${job.status}: ${Object.entries(job.stats).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'no changes'}`, job.status === 'failed');
      const fresh = await api('GET', `/integrations/connections/${id}`);
      $('#jobs').innerHTML = jobsHtml(fresh.jobs);
      bindJobs();
      $('#ctabs [data-tab="jobs"]').click();
      showJob(job.id);
    } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
  }));
  const showJob = async (jobId) => {
    const j = await api('GET', `/integrations/jobs/${jobId}`);
    $('#job-log').innerHTML = `<h3 class="mt">Job #${j.id} log</h3><pre>${j.log.map((l) => `${l.ts.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} ${esc(l.msg)}`).join('\n') || 'No log output'}</pre>`;
  };
  const bindJobs = () => $$('[data-job]').forEach((tr) => tr.addEventListener('click', () => showJob(tr.dataset.job)));
  bindJobs();
  renderMappings($('#ct-mappings'), c, a);
}

function renderMappings(el, c, a) {
  let maps = structuredClone(c.mappings);
  const moduleOpts = (sel) => S.meta.modules.map((m) => `<option value="${m.key}" ${m.key === sel ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  const transforms = ['', 'string', 'number', 'date', 'bool', 'percent_fraction', 'company_name', 'company_email', 'user_email', ...Object.keys(a?.transforms || {})];
  const draw = () => {
    el.innerHTML = `<div class="card"><p class="muted">Each mapping links a remote entity to a Keystone tool. Field rows map a Keystone field to a remote path (dot notation, e.g. <code>PrimaryEmailAddr.Address</code>). Optional value maps translate statuses, e.g. <code>{"open":"Open"}</code> (remote → Keystone).</p>
      ${maps.map((m, i) => {
        const mod = S.modules[m.module];
        const entityDef = a?.entities.find((e) => e.key === m.entity);
        return `<div class="card" style="background:var(--panel-2)" data-map="${i}">
          <div class="form-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
            <div class="field"><label>Remote Entity</label>${a && !a.freeformEntities && a.entities.length ? `<select data-m="entity">${a.entities.map((e) => `<option value="${esc(e.key)}" ${e.key === m.entity ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select>` : `<input data-m="entity" value="${esc(m.entity)}">`}</div>
            <div class="field"><label>Keystone Tool</label><select data-m="module">${moduleOpts(m.module)}</select></div>
            <div class="field"><label>Direction</label><select data-m="direction">${(entityDef ? (entityDef.directions.length > 1 ? ['both', ...entityDef.directions] : entityDef.directions) : ['both', 'pull', 'push']).map((d) => `<option value="${d}" ${d === m.direction ? 'selected' : ''}>${d === 'both' ? '⇅ Two-way' : d === 'pull' ? '⬇ Pull (remote → Keystone)' : '⬆ Push (Keystone → remote)'}</option>`).join('')}</select></div>
            <div class="field"><label>Push filter (JSON)</label><input data-m="filter" value="${esc(m.filter ? JSON.stringify(m.filter) : '')}" placeholder='{"status":"Approved"}'></div>
          </div>
          <table class="lines mt"><thead><tr><th>Keystone Field</th><th>Remote Path</th><th>Transform</th><th>Value Map (JSON)</th><th>Only</th><th></th></tr></thead><tbody>
            ${m.fields.map((f, j) => `<tr data-f="${j}"><td><select data-ff="local">${['number', ...(mod?.fields || []).map((x) => x.key)].map((k) => `<option value="${k}" ${k === f.local ? 'selected' : ''}>${esc(mod?.fields.find((x) => x.key === k)?.label || k)}</option>`).join('')}</select></td>
              <td><input data-ff="remote" value="${esc(f.remote)}"></td><td><select data-ff="transform">${transforms.map((t) => `<option value="${t}" ${t === (f.transform || '') ? 'selected' : ''}>${t || '—'}</option>`).join('')}</select></td>
              <td><input data-ff="map" value="${esc(f.map ? JSON.stringify(f.map) : '')}"></td><td><select data-ff="direction"><option value="">both</option><option ${f.direction === 'pull' ? 'selected' : ''}>pull</option><option ${f.direction === 'push' ? 'selected' : ''}>push</option></select></td>
              <td><button type="button" class="btn small danger" data-rmf="${j}">✕</button></td></tr>`).join('')}
          </tbody></table>
          <div class="btn-row mt"><button type="button" class="btn small" data-addf>+ Field</button><button type="button" class="btn small danger" data-rmm>Remove Mapping</button></div></div>`;
      }).join('') || '<div class="muted">No mappings.</div>'}
      <div class="btn-row"><button class="btn" id="add-map">+ Add Mapping</button><button class="btn primary" id="save-maps">Save Mappings</button></div><div class="form-error mt" id="merr"></div></div>`;
    $('#add-map', el).addEventListener('click', () => { sync(); const e = a?.entities[0]; maps.push({ entity: e?.key || 'records', module: e?.module || 'rfis', direction: e ? (e.directions.length > 1 ? 'both' : e.directions[0]) : 'both', fields: e?.fields ? structuredClone(e.fields) : [] }); draw(); });
    $$('[data-map]', el).forEach((box) => {
      const i = Number(box.dataset.map);
      $('[data-addf]', box).addEventListener('click', () => { sync(); maps[i].fields.push({ local: 'number', remote: '' }); draw(); });
      $('[data-rmm]', box).addEventListener('click', () => { sync(); maps.splice(i, 1); draw(); });
      $$('[data-rmf]', box).forEach((b) => b.addEventListener('click', () => { sync(); maps[i].fields.splice(Number(b.dataset.rmf), 1); draw(); }));
      $('[data-m="module"]', box).addEventListener('change', () => { sync(); draw(); });
      $('[data-m="entity"]', box).addEventListener('change', () => {
        sync();
        const def = a?.entities.find((e) => e.key === maps[i].entity);
        if (def && confirm('Load the default field mapping for this entity?')) { maps[i] = { ...maps[i], module: def.module, fields: structuredClone(def.fields || []), direction: def.directions.length > 1 ? 'both' : def.directions[0] }; }
        draw();
      });
    });
    $('#save-maps', el).addEventListener('click', async () => {
      try {
        sync();
        await api('PATCH', `/integrations/connections/${c.id}`, { mappings: maps });
        toast('Mappings saved');
      } catch (err) { $('#merr', el).textContent = err.message; }
    });
  };
  const sync = () => {
    maps = $$('[data-map]', el).map((box) => {
      const i = Number(box.dataset.map);
      let filter = null;
      const fv = $('[data-m="filter"]', box).value.trim();
      if (fv) { try { filter = JSON.parse(fv); } catch { throw new Error(`Mapping ${i + 1}: push filter is not valid JSON`); } }
      return {
        ...maps[i],
        entity: $('[data-m="entity"]', box).value,
        module: $('[data-m="module"]', box).value,
        direction: $('[data-m="direction"]', box).value,
        filter,
        fields: $$('tr[data-f]', box).map((tr) => {
          const mv = $('[data-ff="map"]', tr).value.trim();
          let map;
          if (mv) { try { map = JSON.parse(mv); } catch { throw new Error(`Mapping ${i + 1}: value map is not valid JSON`); } }
          return { local: $('[data-ff="local"]', tr).value, remote: $('[data-ff="remote"]', tr).value, transform: $('[data-ff="transform"]', tr).value || undefined, map, direction: $('[data-ff="direction"]', tr).value || undefined };
        }),
      };
    });
  };
  draw();
}

async function renderInbound(el, c) {
  const info = await api('GET', `/integrations/connections/${c.id}/inbound`);
  const entity = c.mappings.find((m) => m.direction !== 'push')?.entity || 'vendors';
  el.innerHTML = `<div class="card"><h2>Inbound Webhook</h2><p class="muted">External systems can push changes into Keystone in real time. Payloads are mapped with this connection's pull mappings.</p>
    <div class="detail-grid"><div class="wide"><div class="k">Endpoint</div><div class="v"><code>POST ${esc(info.url)}</code></div></div>
    <div class="wide"><div class="k">Signing Secret</div><div class="v"><code id="secret">${esc(info.secret)}</code> <button class="btn small" id="rotate">Rotate</button></div></div>
    <div class="wide"><div class="k">Signature</div><div class="v"><code>${esc(info.signature_header)}: ${esc(info.algorithm)}</code></div></div></div>
    <h3 class="mt">Example (Node.js)</h3><pre>const body = JSON.stringify({
  entity: "${esc(entity)}",
  action: "upsert",            // or "delete"
  id_field: "id",              // path to the remote id in each record
  records: [{ id: "123", /* remote fields… */ }]
});
const sig = "sha256=" + require("crypto").createHmac("sha256", SECRET).update(body).digest("hex");
await fetch("${esc(info.url)}", { method: "POST", headers: { "Content-Type": "application/json", "X-Keystone-Signature": sig }, body });</pre></div>`;
  $('#rotate', el).addEventListener('click', async () => { if (confirm('Rotate secret? Existing senders will need the new value.')) { const r = await api('POST', `/integrations/connections/${c.id}/rotate-secret`); $('#secret', el).textContent = r.secret; } });
}

async function renderSandbox(el, c, a) {
  const entities = [...new Set([...c.mappings.map((m) => m.entity), ...(a?.entities || []).map((e) => e.key)])];
  el.innerHTML = `<div class="card"><h2>Simulated Remote System</h2><p class="muted">In sandbox mode ${esc(a?.name || '')} is simulated. Inspect what Keystone pushed, or edit remote records and then Pull to watch changes flow back.</p>
    <div class="toolbar"><select id="sb-entity">${entities.map((e) => `<option>${esc(e)}</option>`).join('')}</select><button class="btn" id="sb-load">Load</button></div><div id="sb-body"></div></div>`;
  const load = async () => {
    const entity = $('#sb-entity', el).value;
    const items = await api('GET', `/integrations/connections/${c.id}/sandbox/${encodeURIComponent(entity)}`);
    $('#sb-body', el).innerHTML = `${items.map((it) => `<details class="card"><summary><code>${esc(it.remoteId)}</code> ${esc(Object.values(it.data).find((v) => typeof v === 'string' && v !== it.remoteId) || '')}</summary>
      <textarea style="width:100%;min-height:160px;font-family:monospace" data-rid="${esc(it.remoteId)}">${esc(JSON.stringify(it.data, null, 2))}</textarea><button class="btn small primary mt" data-save="${esc(it.remoteId)}">Save remote change</button></details>`).join('') || '<div class="muted">No remote records yet.</div>'}
      <details class="card"><summary>+ Add remote record</summary><textarea style="width:100%;min-height:120px;font-family:monospace" id="sb-new">{}</textarea><button class="btn small primary mt" id="sb-add">Add</button></details>`;
    const put = async (rid, text) => {
      try { await api('PUT', `/integrations/connections/${c.id}/sandbox/${encodeURIComponent(entity)}`, { remote_id: rid, data: JSON.parse(text) }); toast('Remote record saved – run a Pull to import it'); load(); } catch (err) { toast(err.message, true); }
    };
    $$('[data-save]', el).forEach((b) => b.addEventListener('click', () => put(b.dataset.save, $(`textarea[data-rid="${CSS.escape(b.dataset.save)}"]`, el).value)));
    $('#sb-add', el).addEventListener('click', () => put(null, $('#sb-new', el).value));
  };
  $('#sb-load', el).addEventListener('click', load);
  $('#sb-entity', el).addEventListener('change', load);
  if (entities.length) load();
}

// ─── Webhooks ──────────────────────────────────────────────────────────
async function viewWebhooks(main, guard) {
  const hooks = await api('GET', '/integrations/webhooks');
  if (!guard()) return;
  main.innerHTML = `<div class="page-head"><div class="title"><h1>📡 Webhooks</h1><div class="sub">Push Keystone events to any URL – middleware, iPaaS (Zapier, Make, n8n, Power Automate), data warehouses or your own services. Deliveries are signed and retried with backoff.</div></div></div>
    <form class="card" id="wform"><h2>New Webhook</h2><div class="form-grid">
      <div class="field"><label>Name</label><input name="name" placeholder="ERP middleware"></div>
      <div class="field"><label>URL <span class="req">*</span></label><input name="url" type="url" required placeholder="https://example.com/keystone-events"></div>
      <div class="field"><label>Events</label><input name="events" value="*" placeholder="rfis.*, change_orders.status_changed"><div class="help">Comma-separated patterns. <code>*</code> = everything. Types: <code>&lt;tool&gt;.created|updated|deleted|status_changed</code></div></div>
      <div class="field"><label>Project</label><select name="project_id"><option value="">All projects</option>${S.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
    </div><div class="form-error" id="werr"></div><button class="btn primary mt">Create Webhook</button></form>
    <div class="card"><h2>Subscriptions</h2>${hooks.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Scope</th><th>Status</th><th></th></tr></thead><tbody>
      ${hooks.map((h) => `<tr><td>${esc(h.name || '')}</td><td><code>${esc(h.url)}</code></td><td>${h.events.map((e) => `<span class="tag">${esc(e)}</span>`).join(' ')}</td><td>${h.project_id ? esc(S.projects.find((p) => p.id === h.project_id)?.name || '') : 'All'}</td><td>${h.active ? pill('Active') : pill('Disabled')}</td>
      <td class="nowrap"><button class="btn small" data-test="${h.id}">Send test</button> <button class="btn small" data-dels="${h.id}">Deliveries</button> <button class="btn small" data-toggle="${h.id}" data-active="${h.active}">${h.active ? 'Disable' : 'Enable'}</button> <button class="btn small danger" data-rm="${h.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">No webhooks yet.</div>'}<div id="dels"></div></div>`;
  $('#wform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const h = await api('POST', '/integrations/webhooks', { name: f.name.value, url: f.url.value, events: f.events.value, project_id: Number(f.project_id.value) || null });
      modal(`<h2>Webhook created</h2><p>Use this secret to verify the <code>X-Keystone-Signature</code> header (HMAC-SHA256 of the raw body). It won't be shown again.</p><pre>${esc(h.secret)}</pre><button class="btn primary" data-close>Done</button>`);
      route();
    } catch (err) { $('#werr').textContent = err.message; }
  });
  $$('[data-test]').forEach((b) => b.addEventListener('click', async () => { const d = await api('POST', `/integrations/webhooks/${b.dataset.test}/test`); toast(d ? `Test ${d.status}${d.response_code ? ` (HTTP ${d.response_code})` : ''}${d.last_error ? `: ${d.last_error}` : ''}` : 'Queued', d?.status !== 'delivered'); }));
  $$('[data-toggle]').forEach((b) => b.addEventListener('click', async () => { await api('PATCH', `/integrations/webhooks/${b.dataset.toggle}`, { active: b.dataset.active !== 'true' }); route(); }));
  $$('[data-rm]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete webhook?')) { await api('DELETE', `/integrations/webhooks/${b.dataset.rm}`); route(); } }));
  $$('[data-dels]').forEach((b) => b.addEventListener('click', async () => {
    const ds = await api('GET', `/integrations/webhooks/${b.dataset.dels}/deliveries`);
    $('#dels').innerHTML = `<h3 class="mt">Recent deliveries</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>Event</th><th>Created</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Error</th><th></th></tr></thead><tbody>${ds.map((d) => `<tr><td>${d.id}</td><td>${esc(d.event)}</td><td>${fmtDateTime(d.created_at)}</td><td>${pill(d.status)}</td><td>${d.attempts}</td><td>${d.response_code ?? ''}</td><td>${esc(d.last_error || '')}</td><td><button class="btn small" data-redo="${d.id}">Redeliver</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">None</td></tr>'}</tbody></table></div>`;
    $$('[data-redo]').forEach((x) => x.addEventListener('click', async () => { await api('POST', `/integrations/deliveries/${x.dataset.redo}/redeliver`); toast('Redelivery queued'); }));
  }));
}

// ─── Developers / API keys ─────────────────────────────────────────────
async function viewDevelopers(main, guard) {
  const keys = await api('GET', '/admin/api-keys');
  if (!guard()) return;
  const origin = location.origin;
  main.innerHTML = `<div class="page-head"><div class="title"><h1>🔑 API & Developers</h1><div class="sub">Every tool in Keystone is available over a REST API so any other management system can read and write data.</div></div><a class="btn" href="/api/openapi.json" target="_blank">OpenAPI spec ↗</a></div>
    <div class="grid cols-2"><div class="card"><h2>API Keys</h2>
      <form id="kform" class="toolbar"><input name="name" placeholder="Key name (e.g. Power BI)" required style="flex:1;border:1px solid var(--border);border-radius:6px;padding:7px 10px;background:var(--panel)"><select name="scopes"><option value="read">Read-only</option><option value="write">Read & write</option></select><button class="btn primary">Create Key</button></form>
      ${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Prefix</th><th>Scope</th>${isAdmin() ? '<th>Owner</th>' : ''}<th>Last Used</th><th></th></tr></thead><tbody>${keys.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.scopes)}</td>${isAdmin() ? `<td>${esc(k.owner || '')}</td>` : ''}<td>${fmtDateTime(k.last_used_at) || 'Never'}</td><td><button class="btn small danger" data-revoke="${k.id}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">No keys yet.</div>'}
      <p class="muted mt">Keys act with your permissions (read-only keys can never write).</p></div>
    <div class="card"><h2>Quick Start</h2><pre># List open RFIs on project 1
curl -H "Authorization: Bearer $KEYSTONE_KEY" \\
  "${esc(origin)}/api/projects/1/modules/rfis?open=true"

# Create a punch item
curl -X POST -H "Authorization: Bearer $KEYSTONE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Patch drywall","location":"Room 204"}' \\
  "${esc(origin)}/api/projects/1/modules/punch_list"

# Incremental sync: everything changed since a timestamp
curl -H "Authorization: Bearer $KEYSTONE_KEY" \\
  "${esc(origin)}/api/projects/1/modules/commitments?updated_since=2026-01-01T00:00:00"</pre>
      <h3>Endpoints</h3><ul class="muted" style="padding-left:18px">
        <li><code>/api/projects/{id}/modules/{tool}</code> – list/create/get/update/delete for every project tool</li>
        <li><code>/api/company/modules/{directory|equipment}</code> – company-level tools</li>
        <li><code>/api/projects/{id}/budget</code> – budget with computed columns</li>
        <li><code>/api/projects/{id}/reports/{report}</code> – canned reports</li>
        <li><code>/api/records/{id}/comments|files|activity</code> – collaboration</li>
      </ul>
      <h3>Tools</h3><div>${S.meta.modules.map((m) => `<span class="tag" style="margin:2px">${esc(m.key)}</span>`).join('')}</div></div></div>`;
  $('#kform').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/admin/api-keys', { name: e.target.name.value, scopes: e.target.scopes.value });
      modal(`<h2>API key created</h2><p>${esc(r.note)}</p><pre>${esc(r.key)}</pre><button class="btn primary" data-close>Done</button>`);
      route();
    } catch (err) { toast(err.message, true); }
  });
  $$('[data-revoke]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Revoke this key?')) { await api('DELETE', `/admin/api-keys/${b.dataset.revoke}`); route(); } }));
}

// ─── Admin ─────────────────────────────────────────────────────────────
async function viewUsers(main, guard) {
  const users = await api('GET', '/admin/users');
  if (!guard()) return;
  main.innerHTML = `<div class="page-head"><div class="title"><h1>👥 Users & Permissions</h1></div><button class="btn primary" id="new-user">+ Add User</button></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Role</th><th>Company</th><th class="num">Projects</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.title || '')}</td><td>${esc(S.meta.roles[u.role])}</td><td>${esc(companyName(u.company_id))}</td><td class="num">${u.project_count}</td><td>${u.active ? pill('Active') : pill('Inactive')}</td><td><button class="btn small" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
    <div class="card mt"><h2>Permission Templates</h2><div class="table-wrap"><table><thead><tr><th>Tool</th>${Object.values(S.meta.roles).map((r) => `<th>${esc(r)}</th>`).join('')}</tr></thead><tbody>${S.meta.modules.map((m) => `<tr><td>${m.icon} ${esc(m.label)}</td>${Object.keys(S.meta.roles).map((r) => { const l = S.meta.role_permissions[r][m.key]; return `<td><span class="pill ${l === 'none' ? 's-void' : l === 'read' ? 's-draft' : 's-approved'}">${esc(l)}</span></td>`; }).join('')}</tr>`).join('')}</tbody></table></div><p class="muted">Enforced on every API call, including API keys (which inherit their owner's role).</p></div>`;
  $('#new-user').addEventListener('click', () => userModal());
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => userModal(users.find((u) => u.id === Number(b.dataset.edit)))));
}

function userModal(u) {
  modal(`<h2>${u ? 'Edit User' : 'Add User'}</h2><form id="uform"><div class="form-grid">
    <div class="field"><label>Name *</label><input name="name" required value="${esc(u?.name || '')}"></div>
    <div class="field"><label>Email *</label><input name="email" type="email" ${u ? 'disabled' : 'required'} value="${esc(u?.email || '')}"></div>
    <div class="field"><label>Title</label><input name="title" value="${esc(u?.title || '')}"></div>
    <div class="field"><label>Role</label><select name="role">${Object.entries(S.meta.roles).map(([k, l]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    <div class="field"><label>Company</label><select name="company_id"><option value=""></option>${S.companies.map((c) => `<option value="${c.id}" ${u?.company_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>${u ? 'Reset Password' : 'Password *'}</label><input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></div>
    ${u ? `<div class="field"><label>Status</label><label style="font-weight:400"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label></div>` : `<div class="field wide"><label>Projects</label>${S.projects.map((p) => `<label style="font-weight:400"><input type="checkbox" name="project_ids" value="${p.id}"> ${esc(p.name)}</label>`).join('')}</div>`}
  </div><div class="form-error mt" id="uerr"></div><div class="btn-row mt"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (root, close) => {
    $('#uform', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, title: f.title.value, role: f.role.value, company_id: Number(f.company_id.value) || null };
      if (f.password.value) body.password = f.password.value;
      try {
        if (u) { body.active = f.active.checked; await api('PATCH', `/admin/users/${u.id}`, body); } else {
          body.email = f.email.value;
          body.project_ids = $$('input[name=project_ids]:checked', f).map((x) => Number(x.value));
          await api('POST', '/admin/users', body);
        }
        close();
        await refreshLookups();
        route();
      } catch (err) { $('#uerr', root).textContent = err.errors ? Object.entries(err.errors).map(([k, v]) => `${k} ${v}`).join('; ') : err.message; }
    });
  });
}

async function viewAudit(main, guard) {
  const rows = await api('GET', '/admin/audit?limit=300');
  if (!guard()) return;
  main.innerHTML = `<div class="page-head"><div class="title"><h1>🧾 Audit Log</h1><div class="sub">Every create, update, delete, comment and attachment – by users, API keys and integrations.</div></div></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Project</th><th>Tool</th><th>Summary</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="nowrap">${fmtDateTime(a.ts)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(S.projects.find((p) => p.id === a.project_id)?.name || '')}</td><td>${esc(S.modules[a.module]?.label || '')}</td><td>${a.record_id && a.module ? `<a href="${recordHref(a.module, a.record_id, a.project_id)}">${esc(a.summary || '')}</a>` : esc(a.summary || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

// ─── Boot ──────────────────────────────────────────────────────────────
const savedTheme = safeGet('ks_theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
window.addEventListener('hashchange', route);
route();
