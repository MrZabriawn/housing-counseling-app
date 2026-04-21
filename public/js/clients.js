import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, MONTHS } from './data.js';
import {
  collection, collectionGroup, getDocs, addDoc, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const SS = 'clientsFilters'; // sessionStorage key

let allClients       = [];
let _filteredClients = [];
let _filteredHours   = null;  // hours from session query when date filter active
let _user            = null;  // Firebase Auth user
let _profile         = null;  // Firestore users/{uid} profile
let _counselorDocs   = [];    // { id, name, staffNumber } from counselors collection

// Workshop modal transient state
let _wsClientId   = null;
let _wsClientName = null;

requireAuth(async (user, profile) => {
  _user    = user;
  _profile = profile;
  setupNav(profile, 'clients');

  // Load active counselors for modals
  try {
    const cSnap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    _counselorDocs = cSnap.docs
      .filter(d => d.data().active !== false)
      .map(d => ({ id: d.id, name: d.data().name, staffNumber: d.data().staffNumber ?? null }));
  } catch (_) { _counselorDocs = []; }

  // Show ED-only elements for executive_director role
  if (profile.role === 'executive_director') {
    document.querySelectorAll('.ed-only').forEach(el => el.classList.remove('hidden'));
  }

  populateFilters();
  restoreFilters();
  await loadClients();

  document.getElementById('filterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    saveFilters();
    await applyFilters();
  });
  document.getElementById('clearFilters').addEventListener('click', async () => {
    document.getElementById('filterForm').reset();
    sessionStorage.removeItem(SS);
    await applyFilters();
  });
  document.getElementById('printReportBtn').addEventListener('click', printReport);

  // ── Modal buttons ──────────────────────────────────────────────────────────
  document.getElementById('openCmBtn').addEventListener('click', openCmModal);
  document.getElementById('openEmBtn').addEventListener('click', openEmModal);
  document.getElementById('openWsBtn').addEventListener('click', () => openWsModal());

  // Case Management modal
  document.getElementById('cmCancelBtn').addEventListener('click', () => document.getElementById('cmModal').classList.add('hidden'));
  document.getElementById('cmModal').addEventListener('click', e => { if (e.target === document.getElementById('cmModal')) document.getElementById('cmModal').classList.add('hidden'); });
  document.getElementById('cmSaveBtn').addEventListener('click', saveCm);

  // Executive Management modal
  document.getElementById('emCancelBtn').addEventListener('click', () => document.getElementById('emModal').classList.add('hidden'));
  document.getElementById('emModal').addEventListener('click', e => { if (e.target === document.getElementById('emModal')) document.getElementById('emModal').classList.add('hidden'); });
  document.getElementById('emSaveBtn').addEventListener('click', saveEm);

  // Workshop modal
  document.getElementById('wsCancelBtn').addEventListener('click', () => document.getElementById('wsModal').classList.add('hidden'));
  document.getElementById('wsDoneBtn').addEventListener('click', () => document.getElementById('wsModal').classList.add('hidden'));
  document.getElementById('wsModal').addEventListener('click', e => { if (e.target === document.getElementById('wsModal')) document.getElementById('wsModal').classList.add('hidden'); });
  document.getElementById('wsSaveBtn').addEventListener('click', saveWs);
  document.getElementById('wsAddAnotherBtn').addEventListener('click', wsAddAnother);
  document.getElementById('wsClientClear').addEventListener('click', clearWsClient);
  document.getElementById('wsClientSearch').addEventListener('input', renderWsClientSearch);
  document.querySelectorAll('input[name="wsContact"]').forEach(r => {
    r.addEventListener('change', () => {
      const isEmail = document.querySelector('input[name="wsContact"]:checked').value === 'email';
      document.getElementById('wsContactVal').placeholder = isEmail ? 'email@example.com' : '555-555-5555';
    });
  });
});

function populateFilters() {
  appendOptions('fType',  COUNSELING_TYPES);
  appendOptions('fAmi',   AMI_LEVELS);
  appendOptions('fRe',    RE_CODES);
  appendOptions('fMonth', MONTHS);

  const yearSel  = document.getElementById('fYear');
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y >= 2020; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y;
    yearSel.appendChild(o);
  }
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
  const sel   = document.getElementById('fCounselor');
  const saved = sel.value;
  const names = [...new Set(clients.map(c => (c.counselor || '').trim()).filter(Boolean))].sort();
  while (sel.options.length > 1) sel.remove(1);
  names.forEach(name => {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
  if (saved) sel.value = saved;
}

function saveFilters() {
  sessionStorage.setItem(SS, JSON.stringify({
    name:      document.getElementById('fName').value,
    type:      document.getElementById('fType').value,
    counselor: document.getElementById('fCounselor').value,
    ami:       document.getElementById('fAmi').value,
    re:        document.getElementById('fRe').value,
    status:    document.getElementById('fStatus').value,
    month:     document.getElementById('fMonth').value,
    year:      document.getElementById('fYear').value,
    dateStart: document.getElementById('fDateStart').value,
    dateEnd:   document.getElementById('fDateEnd').value,
  }));
}

function restoreFilters() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SS) || 'null');
    if (!saved) return;
    document.getElementById('fName').value      = saved.name      || '';
    document.getElementById('fType').value      = saved.type      || '';
    document.getElementById('fAmi').value       = saved.ami       || '';
    document.getElementById('fRe').value        = saved.re        || '';
    document.getElementById('fStatus').value    = saved.status    || '';
    document.getElementById('fMonth').value     = saved.month     || '';
    document.getElementById('fYear').value      = saved.year      || '';
    document.getElementById('fDateStart').value = saved.dateStart || '';
    document.getElementById('fDateEnd').value   = saved.dateEnd   || '';
    // Counselor restored after populateCounselorFilter runs
    document.getElementById('fCounselor')._restoreValue = saved.counselor || '';
  } catch (_) {}
}

async function loadClients() {
  document.getElementById('tableBody').innerHTML =
    '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';
  const snap = await getDocs(collection(db, 'clients'));
  allClients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  allClients.sort((a, b) => {
    const da = toDate(a.lastSessionDate).getTime();
    const db_ = toDate(b.lastSessionDate).getTime();
    if (db_ !== da) return db_ - da;
    return (a.clientName || '').localeCompare(b.clientName || '');
  });
  populateCounselorFilter(allClients);
  // Restore counselor selection after options are populated
  const restoreVal = document.getElementById('fCounselor')._restoreValue;
  if (restoreVal) document.getElementById('fCounselor').value = restoreVal;

  await applyFilters();
}

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

function fmtDate(ts) {
  if (!ts) return '—';
  return toDate(ts).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

async function applyFilters() {
  const name      = document.getElementById('fName').value.trim().toLowerCase();
  const type      = document.getElementById('fType').value;
  const counselor = document.getElementById('fCounselor').value;
  const ami       = document.getElementById('fAmi').value;
  const re        = document.getElementById('fRe').value;
  const status    = document.getElementById('fStatus').value;
  const monthVal  = document.getElementById('fMonth').value;
  const yearVal   = parseInt(document.getElementById('fYear').value, 10) || 0;
  const startVal  = document.getElementById('fDateStart').value;
  const endVal    = document.getElementById('fDateEnd').value;

  // Compute effective date range from explicit dates OR from month+year selection
  let start = startVal ? new Date(startVal + 'T00:00:00') : null;
  let end   = endVal   ? new Date(endVal   + 'T23:59:59') : null;

  if (!start && !end && monthVal) {
    const y    = yearVal || new Date().getFullYear();
    const mIdx = MONTHS.indexOf(monthVal);
    start = new Date(y, mIdx, 1, 0, 0, 0);
    end   = new Date(y, mIdx + 1, 0, 23, 59, 59);
  } else if (!start && !end && yearVal) {
    start = new Date(yearVal, 0, 1, 0, 0, 0);
    end   = new Date(yearVal, 11, 31, 23, 59, 59);
  }

  const hasDateFilter = !!(start || end);

  // Standard client-level filters
  let rows = allClients;
  if (name)      rows = rows.filter(c => (c.clientName || '').toLowerCase().includes(name));
  if (type)      rows = rows.filter(c => c.counselingType === type);
  if (counselor) rows = rows.filter(c => c.counselor === counselor);
  if (ami)       rows = rows.filter(c => c.amiPercent === ami);
  if (re)        rows = rows.filter(c => c.reCode === re);
  if (status)    rows = rows.filter(c => (c.status || 'active') === status);

  // Date-based session filter — query sessions, restrict table to matching clientIds
  _filteredHours = null;
  if (hasDateFilter) {
    try {
      const sessSnap = await getDocs(collectionGroup(db, 'sessions'));
      const matchingIds = new Set();
      let hours = 0;
      sessSnap.docs.forEach(d => {
        const s     = d.data();
        const sDate = toDate(s.date);
        if (start && sDate < start) return;
        if (end   && sDate > end)   return;
        if (counselor && (s.counselor || '') !== counselor) return;
        matchingIds.add(d.ref.parent.parent.id);
        hours += Number(s.hours) || 0;
      });
      rows = rows.filter(c => matchingIds.has(c.id));
      _filteredHours = hours;
    } catch (_) {
      _filteredHours = null;
    }
  }

  _filteredClients = rows;
  renderTable(rows);
  renderStats(rows);

  const label = hasDateFilter
    ? `${rows.length} client${rows.length !== 1 ? 's' : ''} with sessions in selected period`
    : rows.length === allClients.length
      ? `${rows.length} clients`
      : `${rows.length} of ${allClients.length} clients`;
  document.getElementById('rowCount').textContent = label;
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
  const active   = clients.filter(c => (c.status || 'active') === 'active').length;
  const sessions = clients.reduce((s, c) => s + (c.sessionCount || 0), 0);
  const dollars  = clients.reduce((s, c) => {
    const val = (c.status === 'closed' && c.closureOutcomeValue > 0)
      ? Number(c.closureOutcomeValue)
      : Number(c.totalOutcomeValue) || 0;
    return s + val;
  }, 0);

  document.getElementById('statClients').textContent  = active;
  document.getElementById('statSessions').textContent = sessions;
  document.getElementById('statHours').textContent    =
    _filteredHours === null
      ? '—'
      : _filteredHours % 1 === 0
        ? _filteredHours.toLocaleString()
        : _filteredHours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
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
  const rows    = _filteredClients;
  const active  = rows.filter(c => (c.status || 'active') === 'active').length;
  const sessions = rows.reduce((s, c) => s + (c.sessionCount || 0), 0);
  const hours   = _filteredHours;
  const dollars = rows.reduce((s, c) => {
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

  const hoursDisplay = hours === null
    ? '—'
    : hours % 1 === 0
      ? hours.toLocaleString()
      : hours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Client Report</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #111; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .stats { display: flex; gap: 2rem; margin-bottom: 1.5rem; border-bottom: 1px solid #ddd; padding-bottom: 1rem; flex-wrap:wrap; }
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
    <div class="stat"><div class="stat-val">${hoursDisplay}</div><div class="stat-lbl">Total Hours</div></div>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDateStr(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { timeZone: 'UTC' });
}
function showErr(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Case Management modal ─────────────────────────────────────────────────────

function openCmModal() {
  document.getElementById('cmDate').value = new Date().toISOString().split('T')[0];
  document.querySelectorAll('input[name="cmParRow"]').forEach(r => { r.checked = false; });
  document.getElementById('cmDesc').value     = '';
  document.getElementById('cmDuration').value = '';
  document.getElementById('cmError').classList.add('hidden');

  const sel = document.getElementById('cmCounselor');
  sel.innerHTML = '<option value="">— Select —</option>';
  _counselorDocs.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
  const mine = _counselorDocs.find(c => c.name === _profile.name);
  if (mine) sel.value = mine.id;

  document.getElementById('cmModal').classList.remove('hidden');
}

async function saveCm() {
  const date     = document.getElementById('cmDate').value;
  const counsId  = document.getElementById('cmCounselor').value;
  const parRow   = document.querySelector('input[name="cmParRow"]:checked')?.value || '';
  const desc     = document.getElementById('cmDesc').value.trim();
  const duration = parseFloat(document.getElementById('cmDuration').value) || 0;
  const errEl    = document.getElementById('cmError');
  const saveBtn  = document.getElementById('cmSaveBtn');

  errEl.classList.add('hidden');
  if (!date)        { showErr(errEl, 'Date is required.');               return; }
  if (!counsId)     { showErr(errEl, 'Select a counselor.');             return; }
  if (!parRow)      { showErr(errEl, 'Select a PAR row.');               return; }
  if (!desc)        { showErr(errEl, 'Description is required.');        return; }
  if (duration <= 0){ showErr(errEl, 'Duration must be greater than 0.'); return; }

  const counsDoc = _counselorDocs.find(c => c.id === counsId);
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'hudTimeEntries'), {
      counselorId:         counsId,
      counselorName:       counsDoc?.name || '',
      month:               date.substring(0, 7),
      date,
      section:             'CML',
      parRow,
      activityDescription: desc,
      hours:               duration,
      enteredBy:           _user.uid,
      createdAt:           serverTimestamp(),
    });
    document.getElementById('cmModal').classList.add('hidden');
  } catch (err) {
    showErr(errEl, 'Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

// ── Executive Management modal (ED only) ──────────────────────────────────────

function openEmModal() {
  document.getElementById('emDate').value = new Date().toISOString().split('T')[0];
  document.querySelectorAll('input[name="emParRow"]').forEach(r => { r.checked = false; });
  document.getElementById('emDesc').value     = '';
  document.getElementById('emDuration').value = '';
  document.getElementById('emError').classList.add('hidden');
  document.getElementById('emCounselorDisplay').textContent = _profile.name || '';
  document.getElementById('emModal').classList.remove('hidden');
}

async function saveEm() {
  const date     = document.getElementById('emDate').value;
  const parRow   = document.querySelector('input[name="emParRow"]:checked')?.value || '';
  const desc     = document.getElementById('emDesc').value.trim();
  const duration = parseFloat(document.getElementById('emDuration').value) || 0;
  const errEl    = document.getElementById('emError');
  const saveBtn  = document.getElementById('emSaveBtn');

  errEl.classList.add('hidden');
  if (!date)        { showErr(errEl, 'Date is required.');               return; }
  if (!parRow)      { showErr(errEl, 'Select a PAR row.');               return; }
  if (!desc)        { showErr(errEl, 'Description is required.');        return; }
  if (duration <= 0){ showErr(errEl, 'Duration must be greater than 0.'); return; }

  const myDoc = _counselorDocs.find(c => c.name === _profile.name);
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'hudTimeEntries'), {
      counselorId:         myDoc?.id || _user.uid,
      counselorName:       _profile.name || '',
      month:               date.substring(0, 7),
      date,
      section:             'CML',
      parRow,
      activityDescription: desc,
      hours:               duration,
      enteredBy:           _user.uid,
      createdAt:           serverTimestamp(),
    });
    document.getElementById('emModal').classList.add('hidden');
  } catch (err) {
    showErr(errEl, 'Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
}

// ── Workshop Entry modal ──────────────────────────────────────────────────────

function openWsModal(prefillName = '', prefillDate = '') {
  document.getElementById('wsFormSection').classList.remove('hidden');
  document.getElementById('wsSuccessSection').classList.add('hidden');

  document.getElementById('wsName').value         = prefillName;
  document.getElementById('wsDate').value         = prefillDate || new Date().toISOString().split('T')[0];
  document.getElementById('wsAttendeeName').value = '';
  document.getElementById('wsAddress').value      = '';
  document.getElementById('wsContactVal').value   = '';
  document.querySelector('input[name="wsContact"][value="email"]').checked = true;
  document.getElementById('wsContactVal').placeholder = 'email@example.com';
  clearWsClient();
  document.getElementById('wsError').classList.add('hidden');
  document.getElementById('wsModal').classList.remove('hidden');
  setTimeout(() => document.getElementById(prefillName ? 'wsAttendeeName' : 'wsName').focus(), 50);
}

function clearWsClient() {
  _wsClientId   = null;
  _wsClientName = null;
  document.getElementById('wsClientId').value = '';
  document.getElementById('wsClientSearch').value = '';
  document.getElementById('wsClientResults').style.display = 'none';
  document.getElementById('wsClientSelected').classList.add('hidden');
}

function renderWsClientSearch() {
  const q       = document.getElementById('wsClientSearch').value.trim().toLowerCase();
  const results = document.getElementById('wsClientResults');

  if (!q || q.length < 2) { results.style.display = 'none'; return; }

  const matches = allClients
    .filter(c => (c.clientName || '').toLowerCase().includes(q))
    .slice(0, 8);

  if (!matches.length) {
    results.innerHTML = '<div style="padding:0.6rem 0.75rem;font-size:0.8125rem;color:var(--text-muted);">No clients found</div>';
    results.style.display = '';
    return;
  }

  results.innerHTML = matches.map(c =>
    `<div class="csr-item" data-id="${escAttr(c.id)}" data-name="${escAttr(c.clientName || '')}"
       style="padding:0.45rem 0.75rem;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.875rem;">
       <div style="font-weight:600;">${escHtml(c.clientName || '')}</div>
       <div style="font-size:0.77rem;color:var(--text-muted);">${escHtml(c.counselingType || '')} · ${escHtml(c.counselor || '')}</div>
     </div>`
  ).join('');
  results.style.display = '';

  results.querySelectorAll('.csr-item').forEach(item => {
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--primary-light,#e8f0fe)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', () => {
      _wsClientId   = item.dataset.id;
      _wsClientName = item.dataset.name;
      document.getElementById('wsClientId').value = _wsClientId;
      document.getElementById('wsClientSelectedName').textContent = _wsClientName;
      document.getElementById('wsClientSelected').classList.remove('hidden');
      document.getElementById('wsClientSearch').value = '';
      results.style.display = 'none';
    });
  });
}

async function saveWs() {
  const name     = document.getElementById('wsName').value.trim();
  const date     = document.getElementById('wsDate').value;
  const attendee = document.getElementById('wsAttendeeName').value.trim();
  const address  = document.getElementById('wsAddress').value.trim();
  const ctType   = document.querySelector('input[name="wsContact"]:checked')?.value || '';
  const ctVal    = document.getElementById('wsContactVal').value.trim();
  const errEl    = document.getElementById('wsError');
  const saveBtn  = document.getElementById('wsSaveBtn');

  errEl.classList.add('hidden');
  if (!name)     { showErr(errEl, 'Workshop name is required.');  return; }
  if (!date)     { showErr(errEl, 'Date is required.');           return; }
  if (!attendee) { showErr(errEl, 'Attendee name is required.');  return; }
  if (!ctVal)    { showErr(errEl, 'Contact value is required.');  return; }

  if (ctType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ctVal)) {
    showErr(errEl, 'Enter a valid email address.'); return;
  }
  if (ctType === 'phone' && ctVal.replace(/\D/g, '').length < 10) {
    showErr(errEl, 'Enter a valid phone number (at least 10 digits).'); return;
  }

  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  try {
    await addDoc(collection(db, 'workshopEntries'), {
      workshopName:   name,
      date,
      attendeeName:   attendee,
      address:        address || '',
      contactType:    ctType,
      contactValue:   ctVal,
      linkedClientId: _wsClientId || null,
      createdAt:      serverTimestamp(),
    });

    // Store workshop name/date on the "Add Another" button for re-open
    const addAnotherBtn = document.getElementById('wsAddAnotherBtn');
    addAnotherBtn.dataset.name = name;
    addAnotherBtn.dataset.date = date;

    document.getElementById('wsSuccessMsg').textContent =
      `${attendee} recorded for "${name}" on ${fmtDateStr(date)}.`;
    document.getElementById('wsFormSection').classList.add('hidden');
    document.getElementById('wsSuccessSection').classList.remove('hidden');
  } catch (err) {
    showErr(errEl, 'Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Save Attendee';
  }
}

function wsAddAnother() {
  const btn = document.getElementById('wsAddAnotherBtn');
  openWsModal(btn.dataset.name || '', btn.dataset.date || '');
}
