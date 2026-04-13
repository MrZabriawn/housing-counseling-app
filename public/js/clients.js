import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES } from './data.js';
import {
  collection, getDocs, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let allClients = [];
let _filteredClients = [];

requireAuth(async (user, profile) => {
  setupNav(profile, 'clients');
  populateFilters();
  await loadClients();

  document.getElementById('filterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    applyFilters();
  });
  document.getElementById('clearFilters').addEventListener('click', () => {
    document.getElementById('filterForm').reset();
    applyFilters();
  });
  document.getElementById('printReportBtn').addEventListener('click', printReport);
});

function populateFilters() {
  appendOptions('fType', COUNSELING_TYPES);
  appendOptions('fAmi',  AMI_LEVELS);
}

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  if (!sel) return;
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

function populateCounselorFilter(clients) {
  const sel = document.getElementById('fCounselor');
  const names = [...new Set(clients.map(c => (c.counselor || '').trim()).filter(Boolean))].sort();
  while (sel.options.length > 1) sel.remove(1);
  names.forEach(name => {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
}

async function loadClients() {
  document.getElementById('tableBody').innerHTML =
    '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';
  const snap = await getDocs(collection(db, 'clients'));
  allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Sort by most recent session descending, then name ascending for ties/no sessions
  allClients.sort((a, b) => {
    const da = toDate(a.lastSessionDate).getTime();
    const db_ = toDate(b.lastSessionDate).getTime();
    if (db_ !== da) return db_ - da;
    return (a.clientName || '').localeCompare(b.clientName || '');
  });
  populateCounselorFilter(allClients);
  applyFilters();
}

function applyFilters() {
  const name     = document.getElementById('fName').value.trim().toLowerCase();
  const type     = document.getElementById('fType').value;
  const counselor = document.getElementById('fCounselor').value;
  const ami      = document.getElementById('fAmi').value;
  const status   = document.getElementById('fStatus').value;

  let rows = allClients;
  if (name)      rows = rows.filter(c => (c.clientName || '').toLowerCase().includes(name));
  if (type)      rows = rows.filter(c => c.counselingType === type);
  if (counselor) rows = rows.filter(c => c.counselor === counselor);
  if (ami)       rows = rows.filter(c => c.amiPercent === ami);
  if (status)    rows = rows.filter(c => (c.status || 'active') === status);

  _filteredClients = rows;
  renderTable(rows);
  renderStats(rows);
  document.getElementById('rowCount').textContent =
    rows.length === allClients.length
      ? `${rows.length} clients`
      : `${rows.length} of ${allClients.length} clients`;
}

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

function fmtDate(ts) {
  if (!ts) return '—';
  return toDate(ts).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function renderTable(clients) {
  const tbody = document.getElementById('tableBody');
  if (!clients.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">No clients found.</td></tr>';
    return;
  }

  tbody.innerHTML = clients.map(c => {
    const status = c.status || 'active';
    const statusBadge = status === 'closed'
      ? `<span class="badge badge-outstanding" style="font-size:0.75rem;">Closed</span>`
      : `<span class="badge badge-pre" style="font-size:0.75rem;">Active</span>`;
    const typeBadge = c.counselingType
      ? `<span class="badge badge-${(c.counselingType||'').toLowerCase()}">${c.counselingType}</span>`
      : '—';

    return `<tr class="clickable-row" data-id="${c.id}" style="cursor:pointer;">
      <td>${c.clientName || '—'}</td>
      <td>${typeBadge}</td>
      <td>${c.counselor || '—'}</td>
      <td>${c.amiPercent || '—'}</td>
      <td style="text-align:center">${c.sessionCount || 0}</td>
      <td>${fmtDate(c.lastSessionDate)}</td>
      <td>${statusBadge}</td>
      <td><a class="btn btn-sm btn-secondary" href="client.html?id=${c.id}">View</a></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      window.location.href = `client.html?id=${tr.dataset.id}`;
    });
  });
}

function renderStats(clients) {
  const active  = clients.filter(c => (c.status || 'active') === 'active').length;
  const sessions = clients.reduce((s, c) => s + (c.sessionCount || 0), 0);
  const dollars  = clients.reduce((s, c) => {
    // Prefer closure outcome value for closed files when set
    const val = (c.status === 'closed' && c.closureOutcomeValue > 0)
      ? Number(c.closureOutcomeValue)
      : Number(c.totalOutcomeValue) || 0;
    return s + val;
  }, 0);

  document.getElementById('statClients').textContent  = active;
  document.getElementById('statSessions').textContent = sessions;
  document.getElementById('statDollars').textContent  =
    '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  renderBreakdown('amiTable',      'amiPercent',     clients);
  renderBreakdown('reTable',       'reCode',         clients);
  renderBreakdown('typeTable',     'counselingType', clients);
  renderCounselorSessionBreakdown(clients);
}

function renderBreakdown(tableId, field, rows) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  const counts = {};
  rows.forEach(r => {
    const key = (r[field] || '').trim() || '(blank)';
    counts[key] = (counts[key] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  tbody.innerHTML = entries.length
    ? entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
    : '<tr><td colspan="2" style="padding:0.5rem;color:var(--text-muted)">No data</td></tr>';
}

function renderCounselorSessionBreakdown(clients) {
  const tbody = document.querySelector('#counselorTable tbody');
  if (!tbody) return;
  const counts = {};
  clients.forEach(c => {
    const key = (c.counselor || '').trim() || '(blank)';
    counts[key] = (counts[key] || 0) + (c.sessionCount || 0);
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  tbody.innerHTML = entries.length
    ? entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')
    : '<tr><td colspan="2" style="padding:0.5rem;color:var(--text-muted)">No data</td></tr>';
}

function printReport() {
  const rows = _filteredClients;
  const active  = rows.filter(c => (c.status || 'active') === 'active').length;
  const sessions = rows.reduce((s, c) => s + (c.sessionCount || 0), 0);
  const dollars  = rows.reduce((s, c) => {
    const val = (c.status === 'closed' && c.closureOutcomeValue > 0)
      ? Number(c.closureOutcomeValue)
      : Number(c.totalOutcomeValue) || 0;
    return s + val;
  }, 0);

  const countBy = (field) => {
    const counts = {};
    rows.forEach(r => { const k = (r[field] || '').trim() || '(blank)'; counts[k] = (counts[k] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  const makeTable = (entries) =>
    entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Client Report</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #111; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .stats { display: flex; gap: 2rem; margin-bottom: 1.5rem; border-bottom: 1px solid #ddd; padding-bottom: 1rem; }
    .stat { text-align: center; }
    .stat-val { font-size: 1.5rem; font-weight: 700; }
    .stat-lbl { font-size: 0.75rem; text-transform: uppercase; color: #666; }
    .rpt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .rpt-section h3 { font-size: 0.8rem; text-transform: uppercase; color: #666; margin-bottom: 0.5rem; border-bottom: 1px solid #eee; padding-bottom: 0.25rem; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
    td:last-child { text-align: right; font-weight: 600; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <h1>Home Stabilization Program — Client Report</h1>
  <div class="subtitle">Generated ${new Date().toLocaleDateString()}</div>
  <div class="stats">
    <div class="stat"><div class="stat-val">${active}</div><div class="stat-lbl">Active Clients</div></div>
    <div class="stat"><div class="stat-val">${sessions}</div><div class="stat-lbl">Total Sessions</div></div>
    <div class="stat"><div class="stat-val">$${dollars.toLocaleString('en-US',{minimumFractionDigits:2})}</div><div class="stat-lbl">Outcome Value</div></div>
  </div>
  <div class="rpt-grid">
    <div class="rpt-section"><h3>Clients by AMI Level</h3><table>${makeTable(countBy('amiPercent'))}</table></div>
    <div class="rpt-section"><h3>Clients by Race &amp; Ethnicity</h3><table>${makeTable(countBy('reCode'))}</table></div>
    <div class="rpt-section"><h3>Clients by Counseling Type</h3><table>${makeTable(countBy('counselingType'))}</table></div>
    <div class="rpt-section"><h3>Clients by Counselor</h3><table>${makeTable(countBy('counselor'))}</table></div>
  </div>
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`);
  win.document.close();
}
