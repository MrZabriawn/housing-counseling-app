import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { isDemoMode, demoClientName } from './demo-mode.js';
import { COUNSELING_TYPES, AMI_LEVELS, RE_CODES, MONTHS, BILLING_TYPES, RX_GUARANTORS, amiCategory, amiDisplayLabel } from './data.js';
import {
  collection, collectionGroup, getDocs, addDoc, query, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const SS = 'clientsFilters'; // sessionStorage key

let allClients       = [];
let _filteredClients = [];
let _allSessions     = [];    // { clientId, date, hours, counselor, ... } loaded once on init
let _filteredHours   = null;  // computed hours for visible clients (always set after load)
let _displayLimit    = 25;    // rows currently shown; expanded by "Show more"
let _user            = null;  // Firebase Auth user
let _profile         = null;  // Firestore users/{uid} profile
let _counselorDocs   = [];    // { id, name, staffNumber } from counselors collection


let _metricsRendered   = false; // true after first visit to Metrics tab
let _rxGuarantorMap    = new Map(); // rxNumber string → guarantor string
let _matchingSessions  = null;  // null = client view; array = session view (date filter active)

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
  showIncompleteBanner();

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

  // ── Page tab switching ──────────────────────────────────────────────────
  document.querySelectorAll('.page-tab').forEach(tab => {
    tab.addEventListener('click', () => switchPageTab(tab.dataset.tab));
  });

  // ── Modal buttons ──────────────────────────────────────────────────────────
  document.getElementById('openCmBtn').addEventListener('click', openCmModal);
  document.getElementById('openEmBtn').addEventListener('click', openEmModal);
  // Case Management modal
  document.getElementById('cmCancelBtn').addEventListener('click', () => document.getElementById('cmModal').classList.add('hidden'));
  document.getElementById('cmModal').addEventListener('click', e => { if (e.target === document.getElementById('cmModal')) document.getElementById('cmModal').classList.add('hidden'); });
  document.getElementById('cmSaveBtn').addEventListener('click', saveCm);

  // Executive Management modal
  document.getElementById('emCancelBtn').addEventListener('click', () => document.getElementById('emModal').classList.add('hidden'));
  document.getElementById('emModal').addEventListener('click', e => { if (e.target === document.getElementById('emModal')) document.getElementById('emModal').classList.add('hidden'); });
  document.getElementById('emSaveBtn').addEventListener('click', saveEm);

});

function populateFilters() {
  appendOptions('fType',     COUNSELING_TYPES);
  appendOptions('fAmi',      AMI_LEVELS);
  appendOptions('fRe',       RE_CODES);
  appendOptions('fMonth',    MONTHS);
  appendOptions('fHudType',  BILLING_TYPES);
  appendOptions('fGuarantor', RX_GUARANTORS);

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
    hudType:   document.getElementById('fHudType').value,
    guarantor: document.getElementById('fGuarantor').value,
    month:     document.getElementById('fMonth').value,
    year:      document.getElementById('fYear').value,
    dateStart: document.getElementById('fDateStart').value,
    dateEnd:   document.getElementById('fDateEnd').value,
    rx:        document.getElementById('fRx')?.value || '',
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
    document.getElementById('fHudType').value   = saved.hudType   || '';
    document.getElementById('fGuarantor').value = saved.guarantor || '';
    document.getElementById('fMonth').value     = saved.month     || '';
    document.getElementById('fYear').value      = saved.year      || '';
    document.getElementById('fDateStart').value = saved.dateStart || '';
    document.getElementById('fDateEnd').value   = saved.dateEnd   || '';
    if (document.getElementById('fRx')) document.getElementById('fRx').value = saved.rx || '';
    // Counselor restored after populateCounselorFilter runs
    document.getElementById('fCounselor')._restoreValue = saved.counselor || '';
  } catch (_) {}
}

function canViewClient(c) {
  const tier = c.confidentialityTier || 'standard';
  if (tier === 'standard') return true;
  if (_profile.role === 'executive_director') return true;
  return _user != null && (c.careTeam || []).includes(_user.uid);
}

async function loadClients() {
  document.getElementById('tableBody').innerHTML =
    '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';

  const [clientSnap, sessSnap, rxSnap] = await Promise.all([
    getDocs(collection(db, 'clients')),
    getDocs(collectionGroup(db, 'sessions')),
    getDocs(collectionGroup(db, 'rxNumbers')),
  ]);

  allClients   = clientSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(canViewClient);
  _allSessions = sessSnap.docs.map(d => ({ clientId: d.ref.parent.parent.id, ...d.data() }));
  _rxGuarantorMap = new Map(
    rxSnap.docs.map(d => [d.data().rxNumber, d.data().guarantor]).filter(([rx]) => rx)
  );

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
  const rxFilter  = document.getElementById('fRx')?.value.trim().toLowerCase() || '';

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
  if (counselor) rows = rows.filter(c => c.counselor === counselor);
  if (ami)       rows = rows.filter(c => amiCategory(c.amiPercent) === ami);
  if (re)        rows = rows.filter(c => c.reCode === re);
  if (status)    rows = rows.filter(c => (c.status || 'active') === status);
  if (rxFilter) {
    const rxSessionIds = new Set(_allSessions.filter(s => (s.rxNumber || '').toLowerCase().includes(rxFilter)).map(s => s.clientId));
    rows = rows.filter(c => rxSessionIds.has(c.id) || (c.rxNumbers || []).some(r => (r || '').toLowerCase().includes(rxFilter)));
  }

  const hudType   = document.getElementById('fHudType').value;
  const guarantor = document.getElementById('fGuarantor').value;
  const hasSessionFilter = hasDateFilter || !!type || !!hudType || !!guarantor;

  // Compute hours from preloaded sessions; session filters also restrict the client table
  let hours = 0;
  if (hasSessionFilter) {
    const matchingIds = new Set();
    const sessionRows = [];
    _allSessions.forEach(s => {
      if (hasDateFilter) {
        const sDate = toDate(s.date);
        if (start && sDate < start) return;
        if (end   && sDate > end)   return;
      }
      if (counselor  && (s.counselor      || '') !== counselor)                    return;
      if (type       && (s.counselingType || '') !== type)                         return;
      if (hudType    && (s.hudType        || '') !== hudType)                      return;
      if (guarantor  && _rxGuarantorMap.get(s.rxNumber || '') !== guarantor)       return;
      matchingIds.add(s.clientId);
      if (hasDateFilter) {
        hours += Number(s.hours) || 0;
        sessionRows.push(s);
      }
    });
    rows = rows.filter(c => matchingIds.has(c.id));
    _matchingSessions = hasDateFilter
      ? sessionRows.slice().sort((a, b) => {
          const da = toDate(a.date), db2 = toDate(b.date);
          return da - db2;
        })
      : null;
    if (!hasDateFilter) {
      const visibleIds = new Set(rows.map(c => c.id));
      _allSessions.forEach(s => { if (visibleIds.has(s.clientId)) hours += Number(s.hours) || 0; });
    }
  } else {
    _matchingSessions = null;
    const visibleIds = new Set(rows.map(c => c.id));
    _allSessions.forEach(s => {
      if (visibleIds.has(s.clientId)) hours += Number(s.hours) || 0;
    });
  }
  _filteredHours = hours;

  _filteredClients = rows;
  _displayLimit    = 25;
  renderTable(rows);
  renderStats(rows);
  if (_metricsRendered) renderMetrics();

  let label;
  if (_matchingSessions !== null) {
    const sc = _matchingSessions.length;
    const cc = rows.length;
    label = `${sc} session${sc !== 1 ? 's' : ''} across ${cc} client${cc !== 1 ? 's' : ''} in selected period`;
  } else if (rows.length === allClients.length) {
    label = `${rows.length} clients`;
  } else {
    label = `${rows.length} of ${allClients.length} clients`;
  }
  document.getElementById('rowCount').textContent = label;
}

function renderTable(clients) {
  const tbody   = document.getElementById('tableBody');
  const footer  = document.getElementById('tableFooter');
  const headRow = document.getElementById('tableHeadRow');

  // ── Session view (date filter active) ──────────────────────────────────────
  if (_matchingSessions !== null) {
    headRow.innerHTML = `
      <th>Client Name</th>
      <th>Date</th>
      <th>Type</th>
      <th>Billing Type</th>
      <th>Counselor</th>
      <th style="text-align:center">Hours</th>
      <th style="text-align:center">Drive</th>
      <th></th>`;

    if (!_matchingSessions.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">No sessions found in selected period.</td></tr>';
      if (footer) footer.innerHTML = '';
      return;
    }

    const clientMap = new Map(allClients.map(c => [c.id, c]));
    const visible   = _matchingSessions.slice(0, _displayLimit);

    tbody.innerHTML = visible.map(s => {
      const c    = clientMap.get(s.clientId) || {};
      const displayName = isDemoMode() ? demoClientName(s.clientId) : (c.clientName || '—');
      const tier = c.confidentialityTier || 'standard';
      const tierBadge = tier === 'sealed'
        ? `<span title="Protected" style="font-size:0.7rem;font-weight:700;color:#7c3aed;margin-left:0.3rem;">&#128274;</span>`
        : tier === 'restricted'
        ? `<span title="Confidential" style="font-size:0.7rem;font-weight:700;color:#b45309;margin-left:0.3rem;">&#128274;</span>`
        : '';
      const typeBadge = s.counselingType
        ? `<span class="badge badge-${(s.counselingType || '').toLowerCase()}">${s.counselingType}</span>`
        : '—';
      const sDriveCell = c.driveFolderUrl
        ? `<a href="${c.driveFolderUrl}" target="_blank" rel="noopener" title="Open Drive Folder" style="color:#4285f4;font-size:1.1rem;text-decoration:none;">📁</a>`
        : `<span style="color:var(--border,#dee2e6);" title="No Drive folder linked">—</span>`;
      return `<tr class="clickable-row" data-id="${s.clientId}" style="cursor:pointer;">
        <td>${displayName}${tierBadge}</td>
        <td>${fmtDate(s.date)}</td>
        <td>${typeBadge}</td>
        <td>${s.hudType || '—'}</td>
        <td>${s.counselor || '—'}</td>
        <td style="text-align:center">${s.hours ?? '—'}</td>
        <td style="text-align:center">${sDriveCell}</td>
        <td><a class="btn btn-sm btn-secondary" href="client.html?id=${s.clientId}">View</a></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        window.location.href = `client.html?id=${tr.dataset.id}`;
      });
    });

    if (footer) {
      const remaining = _matchingSessions.length - visible.length;
      if (remaining <= 0) {
        footer.innerHTML = '';
      } else {
        footer.innerHTML = `
          <tr>
            <td colspan="8" style="text-align:center;padding:0.75rem;background:#f8f9fb;border-top:2px solid var(--border);">
              <span style="font-size:0.8125rem;color:var(--text-muted);margin-right:1rem;">
                Showing ${visible.length} of ${_matchingSessions.length}
              </span>
              <button id="showMoreBtn" class="btn btn-secondary btn-sm" style="margin-right:0.5rem;">
                Show ${Math.min(25, remaining)} more
              </button>
              <button id="showAllBtn" class="btn btn-secondary btn-sm">Show all ${_matchingSessions.length}</button>
            </td>
          </tr>`;
        document.getElementById('showMoreBtn').addEventListener('click', () => {
          _displayLimit += 25;
          renderTable(_filteredClients);
        });
        document.getElementById('showAllBtn').addEventListener('click', () => {
          _displayLimit = _matchingSessions.length;
          renderTable(_filteredClients);
        });
      }
    }
    return;
  }

  // ── Client view (no date filter) ───────────────────────────────────────────
  headRow.innerHTML = `
    <th>Client Name</th>
    <th>Type</th>
    <th>Counselor</th>
    <th>AMI</th>
    <th style="text-align:center">Sessions</th>
    <th>Last Visit</th>
    <th>Status</th>
    <th></th>`;

  if (!clients.length) {
    tbody.innerHTML  = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-muted)">No clients found.</td></tr>';
    if (footer) footer.innerHTML = '';
    return;
  }

  const visible = clients.slice(0, _displayLimit);

  tbody.innerHTML = visible.map(c => {
    const status = c.status || 'active';
    const statusBadge = status === 'closed'
      ? `<span class="badge badge-outstanding" style="font-size:0.75rem;">Closed</span>`
      : `<span class="badge badge-pre" style="font-size:0.75rem;">Active</span>`;
    const typeBadge = c.counselingType
      ? `<span class="badge badge-${(c.counselingType||'').toLowerCase()}">${c.counselingType}</span>`
      : '—';
    const tier = c.confidentialityTier || 'standard';
    const tierBadge = tier === 'sealed'
      ? `<span title="Protected" style="font-size:0.7rem;font-weight:700;color:#7c3aed;margin-left:0.3rem;">&#128274;</span>`
      : tier === 'restricted'
      ? `<span title="Confidential" style="font-size:0.7rem;font-weight:700;color:#b45309;margin-left:0.3rem;">&#128274;</span>`
      : '';

    const displayName = isDemoMode() ? demoClientName(c.id) : (c.clientName || '—');
    const driveCell = c.driveFolderUrl
      ? `<a href="${c.driveFolderUrl}" target="_blank" rel="noopener" title="Open Drive Folder" style="color:#4285f4;font-size:1.1rem;text-decoration:none;">📁</a>`
      : `<span style="color:var(--border,#dee2e6);" title="No Drive folder linked">—</span>`;
    return `<tr class="clickable-row" data-id="${c.id}" style="cursor:pointer;">
      <td>${displayName}${tierBadge}</td>
      <td>${typeBadge}</td>
      <td>${c.counselor || '—'}</td>
      <td>${amiDisplayLabel(c.amiPercent) || '—'}</td>
      <td style="text-align:center">${c.sessionCount || 0}</td>
      <td>${fmtDate(c.lastSessionDate)}</td>
      <td>${statusBadge}</td>
      <td style="text-align:center">${driveCell}</td>
      <td><a class="btn btn-sm btn-secondary" href="client.html?id=${c.id}">View</a></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      window.location.href = `client.html?id=${tr.dataset.id}`;
    });
  });

  if (footer) {
    const remaining = clients.length - visible.length;
    if (remaining <= 0) {
      footer.innerHTML = '';
    } else {
      footer.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center;padding:0.75rem;background:#f8f9fb;border-top:2px solid var(--border);">
            <span style="font-size:0.8125rem;color:var(--text-muted);margin-right:1rem;">
              Showing ${visible.length} of ${clients.length}
            </span>
            <button id="showMoreBtn" class="btn btn-secondary btn-sm" style="margin-right:0.5rem;">
              Show ${Math.min(25, remaining)} more
            </button>
            <button id="showAllBtn" class="btn btn-secondary btn-sm">Show all ${clients.length}</button>
          </td>
        </tr>`;

      document.getElementById('showMoreBtn').addEventListener('click', () => {
        _displayLimit += 25;
        renderTable(_filteredClients);
      });
      document.getElementById('showAllBtn').addEventListener('click', () => {
        _displayLimit = _filteredClients.length;
        renderTable(_filteredClients);
      });
    }
  }
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

  renderBreakdown('amiTable',      'amiPercent',     clients.map(c => ({ ...c, amiPercent: amiCategory(c.amiPercent) })));
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
  if (isDemoMode()) return;
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
    rows.forEach(r => {
      const raw = r[field];
      const k = field === 'amiPercent'
        ? (amiCategory(raw) || '(blank)')
        : ((raw || '').trim() || '(blank)');
      counts[k] = (counts[k] || 0) + 1;
    });
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
  document.getElementById('cmDesc').value         = '';
  document.getElementById('cmDuration').value     = '';
  document.getElementById('cmRxNumber').value     = '';
  document.getElementById('cmClientSearch').value = '';
  document.getElementById('cmClientId').value     = '';
  document.getElementById('cmClientDropdown').style.display = 'none';
  document.getElementById('cmClientChip').style.display     = 'none';
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

  const gSel = document.getElementById('cmGuarantor');
  gSel.innerHTML = '<option value="">— None —</option>';
  RX_GUARANTORS.forEach(g => {
    const o = document.createElement('option');
    o.value = g; o.textContent = g;
    gSel.appendChild(o);
  });

  document.getElementById('cmModal').classList.remove('hidden');
  wireCmClientSearch();
}

async function saveCm() {
  const date      = document.getElementById('cmDate').value;
  const counsId   = document.getElementById('cmCounselor').value;
  const parRow    = document.querySelector('input[name="cmParRow"]:checked')?.value || '';
  const desc      = document.getElementById('cmDesc').value.trim();
  const duration  = parseFloat(document.getElementById('cmDuration').value) || 0;
  const clientId  = document.getElementById('cmClientId').value || '';
  const rxNumber  = document.getElementById('cmRxNumber').value.trim();
  const guarantor = document.getElementById('cmGuarantor').value;
  const errEl     = document.getElementById('cmError');
  const saveBtn   = document.getElementById('cmSaveBtn');

  errEl.classList.add('hidden');
  if (!date)        { showErr(errEl, 'Date is required.');                return; }
  if (!counsId)     { showErr(errEl, 'Select a counselor.');              return; }
  if (!parRow)      { showErr(errEl, 'Select a PAR row.');                return; }
  if (!desc)        { showErr(errEl, 'Description is required.');         return; }
  if (duration <= 0){ showErr(errEl, 'Duration must be greater than 0.'); return; }

  const counsDoc   = _counselorDocs.find(c => c.id === counsId);
  const clientDoc  = clientId ? allClients.find(c => c.id === clientId) : null;
  const clientName = clientDoc?.clientName || '';
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
      ...(clientId   ? { clientId, clientName }       : {}),
      ...(rxNumber   ? { rxNumber }                   : {}),
      ...(guarantor  ? { guarantor }                  : {}),
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

function wireCmClientSearch() {
  const input    = document.getElementById('cmClientSearch');
  const dropdown = document.getElementById('cmClientDropdown');
  const hiddenId = document.getElementById('cmClientId');
  const chip     = document.getElementById('cmClientChip');
  const chipName = document.getElementById('cmClientChipName');

  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    dropdown.innerHTML = '';
    if (!q) { dropdown.style.display = 'none'; return; }
    const matches = allClients.filter(c => (c.clientName || '').toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { dropdown.style.display = 'none'; return; }
    matches.forEach(c => {
      const li = document.createElement('li');
      li.textContent = c.clientName;
      li.style.cssText = 'padding:0.4rem 0.75rem;cursor:pointer;font-size:0.875rem;';
      li.onmouseenter = () => li.style.background = '#f0f4ff';
      li.onmouseleave = () => li.style.background = '';
      li.onclick = () => {
        hiddenId.value    = c.id;
        chipName.textContent = c.clientName;
        chip.style.display = 'flex';
        input.value       = '';
        dropdown.style.display = 'none';
      };
      dropdown.appendChild(li);
    });
    dropdown.style.display = 'block';
  };

  document.getElementById('cmClearClient').onclick = () => {
    hiddenId.value = '';
    chip.style.display = 'none';
    input.value = '';
  };

  document.addEventListener('click', e => {
    if (!e.target.closest('#cmClientSearch') && !e.target.closest('#cmClientDropdown')) {
      dropdown.style.display = 'none';
    }
  }, { once: false });
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

// ── Incomplete files banner ────────────────────────────────────────────────────
function showIncompleteBanner() {
  const banner = document.getElementById('incompleteBanner');
  if (!banner || !_user || !_profile) return;

  const storageKey = `incompleteHidden-${_user.uid}`;
  if (sessionStorage.getItem(storageKey)) return;

  const myName    = _profile.name || '';
  const CUTOFF    = new Date('2026-01-01');
  const toDateTs  = ts => ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
  const incomplete = allClients
    .filter(c => {
      if (c.counselor !== myName || c.status === 'closed') return false;
      const last = toDateTs(c.lastSessionDate) || toDateTs(c.firstSessionDate);
      return last && last >= CUTOFF;
    })
    .reduce((acc, c) => {
      const issues = [];
      if (!c.amiPercent)               issues.push('AMI');
      if (!c.reCode)                   issues.push('R/E');
      if (!c.rxNumbers?.length)        issues.push('Rx/Guarantor');
      if (issues.length) acc.push({ ...c, issues });
      return acc;
    }, []);

  if (!incomplete.length) return;

  const shown = incomplete.slice(0, 5);
  const extra = incomplete.length - 5;

  const rows = shown.map(c => {
    const chips = c.issues.map(i =>
      `<span style="background:#fef3c7;color:#92400e;padding:0.1rem 0.4rem;border-radius:10px;font-size:0.7rem;font-weight:700;">${escHtml(i)}</span>`
    ).join(' ');
    const incName = isDemoMode() ? demoClientName(c.id) : (c.clientName || '—');
    return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <a href="client.html?id=${escAttr(c.id)}" style="font-weight:600;font-size:0.8125rem;color:var(--primary);">${escHtml(incName)}</a>
      <span style="display:flex;gap:0.25rem;">${chips}</span>
    </div>`;
  }).join('');

  const moreHtml = extra > 0
    ? `<div style="margin-top:0.35rem;font-size:0.78rem;color:var(--text-muted);">…and ${extra} more &nbsp;·&nbsp; <a href="reports.html?tab=incomplete" style="color:var(--primary);font-weight:600;">Review all →</a></div>`
    : `<div style="margin-top:0.35rem;font-size:0.78rem;"><a href="reports.html?tab=incomplete" style="color:var(--primary);font-weight:600;">Review all incomplete files →</a></div>`;

  banner.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;">
      <div style="flex:1;">
        <div style="font-weight:700;font-size:0.8125rem;margin-bottom:0.4rem;color:#92400e;">
          ${incomplete.length} client file${incomplete.length !== 1 ? 's' : ''} with missing info needed for billing
        </div>
        ${rows}
        ${moreHtml}
      </div>
      <button id="dismissIncompleteBtn" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:1.25rem;padding:0;line-height:1;flex-shrink:0;" title="Dismiss">&times;</button>
    </div>`;

  banner.classList.remove('hidden');
  document.getElementById('dismissIncompleteBtn').addEventListener('click', () => {
    sessionStorage.setItem(storageKey, '1');
    banner.classList.add('hidden');
  });
}

// ── Page tab switching ────────────────────────────────────────────────────────

function switchPageTab(tabId) {
  document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.page-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
  if (tabId === 'metrics-panel') {
    _metricsRendered = true;
    renderMetrics();
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function getActiveDateRange() {
  const startVal = document.getElementById('fDateStart').value;
  const endVal   = document.getElementById('fDateEnd').value;
  const monthVal = document.getElementById('fMonth').value;
  const yearVal  = parseInt(document.getElementById('fYear').value, 10) || 0;

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
  return { start, end };
}

function getMetricSessions() {
  const { start, end } = getActiveDateRange();
  const ids = new Set(_filteredClients.map(c => c.id));
  return _allSessions.filter(s => {
    if (!ids.has(s.clientId)) return false;
    const d = toDate(s.date);
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    return true;
  });
}

function mxStat(label, value) {
  return `<div class="mx-stat"><div class="mx-stat-label">${label}</div><div class="mx-stat-val">${value}</div></div>`;
}

function mxPct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) + '%' : '—';
}

function mxBarTable(rows, total) {
  if (!rows.length) return '<p style="color:var(--text-muted);font-size:0.875rem;">No data</p>';
  return `<table class="mx-table">
    <thead><tr><th>Category</th><th>Count</th><th>%</th><th style="width:120px;"></th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr>
      <td>${escHtml(k)}</td>
      <td style="font-weight:600;">${v}</td>
      <td style="color:var(--text-muted);">${mxPct(v, total)}</td>
      <td><div class="mx-bar-track"><div class="mx-bar-fill" style="width:${Math.round((v/Math.max(total,1))*100)}%"></div></div></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderMetrics() {
  const clients  = _filteredClients;
  const sessions = getMetricSessions();
  const total    = clients.length;
  const { start, end } = getActiveDateRange();
  const hasPeriod = !!(start || end);

  // ── Overview ─────────────────────────────────────────────────────────────
  const active   = clients.filter(c => (c.status || 'active') === 'active').length;
  const closed   = clients.filter(c => c.status === 'closed').length;

  let overviewHtml = `<div class="mx-stat-row">${
    mxStat('Total Clients', total) +
    mxStat('Active', active) +
    mxStat('Closed', closed)
  }`;

  if (hasPeriod) {
    const newIntakes = clients.filter(c => {
      if (!c.intakeDate) return false;
      const d = new Date(c.intakeDate);
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    }).length;
    const closures = clients.filter(c => {
      if (!c.closureDate) return false;
      const d = toDate(c.closureDate);
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    }).length;
    overviewHtml += mxStat('New Intakes', newIntakes) + mxStat('Closures', closures);
  }

  document.getElementById('mxOverviewBody').innerHTML = overviewHtml + '</div>';

  // ── Sessions & Hours ─────────────────────────────────────────────────────
  const totalSessions = sessions.length;
  const totalHours    = sessions.reduce((s, r) => s + (Number(r.hours) || 0), 0);
  const avgSessions   = total > 0 ? (totalSessions / total).toFixed(1) : '—';
  const avgHours      = total > 0 ? (totalHours / total).toFixed(1) : '—';
  const fmtH = h => h % 1 === 0 ? h.toLocaleString() : h.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  document.getElementById('mxSessionsBody').innerHTML =
    `<div class="mx-stat-row">${
      mxStat('Sessions', totalSessions) +
      mxStat('Hours', fmtH(totalHours)) +
      mxStat('Avg Sessions / Client', avgSessions) +
      mxStat('Avg Hours / Client', avgHours)
    }</div>`;

  // ── By Counseling Type ───────────────────────────────────────────────────
  const typeCounts = {};
  clients.forEach(c => { const k = c.counselingType || '(none)'; typeCounts[k] = (typeCounts[k] || 0) + 1; });
  document.getElementById('mxTypesBody').innerHTML =
    mxBarTable(Object.entries(typeCounts).sort((a, b) => b[1] - a[1]), total);

  // ── AMI Distribution ─────────────────────────────────────────────────────
  const amiCounts = {};
  clients.forEach(c => { const k = amiCategory(c.amiPercent) || '(not set)'; amiCounts[k] = (amiCounts[k] || 0) + 1; });
  document.getElementById('mxAmiBody').innerHTML =
    mxBarTable(Object.entries(amiCounts).sort((a, b) => b[1] - a[1]), total);

  // ── Demographics ─────────────────────────────────────────────────────────
  const hispanic    = clients.filter(c => c.hispanic).length;
  const femaleHd    = clients.filter(c => c.femaleHeaded).length;
  document.getElementById('mxDemoBody').innerHTML =
    `<div class="mx-stat-row">${
      mxStat('Hispanic / Latino', `${hispanic} (${mxPct(hispanic, total)})`) +
      mxStat('Female-Headed HH', `${femaleHd} (${mxPct(femaleHd, total)})`)
    }</div>`;

  // ── Counselor Breakdown ──────────────────────────────────────────────────
  const byCounselor = {};
  sessions.forEach(s => {
    const k = (s.counselor || '').trim() || '(unassigned)';
    if (!byCounselor[k]) byCounselor[k] = { sessions: 0, hours: 0, clients: new Set() };
    byCounselor[k].sessions++;
    byCounselor[k].hours += Number(s.hours) || 0;
    byCounselor[k].clients.add(s.clientId);
  });
  const counselorRows = Object.entries(byCounselor).sort((a, b) => b[1].sessions - a[1].sessions);
  document.getElementById('mxCounselorsBody').innerHTML = counselorRows.length
    ? `<table class="mx-table"><thead><tr>
        <th>Counselor</th><th>Clients</th><th>Sessions</th><th>Hours</th>
      </tr></thead><tbody>${counselorRows.map(([k, v]) =>
        `<tr><td>${escHtml(k)}</td><td>${v.clients.size}</td><td style="font-weight:600;">${v.sessions}</td>
         <td>${fmtH(v.hours)}</td></tr>`
      ).join('')}</tbody></table>`
    : '<p style="color:var(--text-muted);font-size:0.875rem;">No session data</p>';

  // ── R&E Codes ────────────────────────────────────────────────────────────
  const reCounts = {};
  clients.forEach(c => { const k = c.reCode || '(not set)'; reCounts[k] = (reCounts[k] || 0) + 1; });
  document.getElementById('mxReBody').innerHTML =
    mxBarTable(Object.entries(reCounts).sort((a, b) => b[1] - a[1]), total);

  // ── Court Activity ───────────────────────────────────────────────────────
  const courtClients  = clients.filter(c => c.counselingType === 'COURT').length;
  const courtSessions = sessions.filter(s => (s.caseStatus || '').startsWith('Court')).length;
  const courtHours    = sessions
    .filter(s => (s.caseStatus || '').startsWith('Court'))
    .reduce((s, r) => s + (Number(r.hours) || 0), 0);
  document.getElementById('mxCourtBody').innerHTML =
    `<div class="mx-stat-row">${
      mxStat('Court-Type Clients', courtClients) +
      mxStat('Court Sessions', courtSessions) +
      mxStat('Court Hours', fmtH(courtHours))
    }</div>`;

  // ── File Completeness ────────────────────────────────────────────────────
  const REQUIRED_FIELDS = ['clientName', 'counselingType', 'counselor', 'reCode', 'amiPercent', 'intakeDate'];
  let complete = 0;
  const missingFreq = {};
  clients.forEach(c => {
    const missing = REQUIRED_FIELDS.filter(f => !c[f]);
    if (!missing.length) { complete++; }
    else { missing.forEach(f => { missingFreq[f] = (missingFreq[f] || 0) + 1; }); }
  });
  const incomplete = total - complete;
  const pct = total > 0 ? Math.round((complete / total) * 100) : 0;
  const missingRows = Object.entries(missingFreq).sort((a, b) => b[1] - a[1]);
  const missingHtml = missingRows.length
    ? `<table class="mx-table" style="margin-top:0.75rem;max-width:320px;">
        <thead><tr><th>Missing Field</th><th>Files Affected</th></tr></thead>
        <tbody>${missingRows.map(([k, v]) => `<tr><td style="font-family:monospace;font-size:0.8rem;">${escHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody>
      </table>` : '';

  document.getElementById('mxCompleteBody').innerHTML =
    `<div class="mx-stat-row">${
      mxStat('Complete Files', `${complete} (${pct}%)`) +
      mxStat('Incomplete', incomplete)
    }</div>${missingHtml}`;
}

