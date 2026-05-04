import { db } from './firebase-config.js';
import { requireAuth, setupNav, isAdmin } from './auth.js';
import { MONTHS, AMI_LEVELS, RE_CODES, COUNSELING_TYPES, amiCategory } from './data.js';
import {
  collection, getDocs, deleteDoc, doc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let currentProfile = null;
let allRows = [];
let _filteredRows = [];

function currentRows() { return _filteredRows; }

requireAuth(async (user, profile) => {
  currentProfile = profile;
  setupNav(profile, 'log');
  populateFilters();
  await loadLog();

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

function printReport() {
  const filterDesc = getFilterDescription();
  const unique      = uniqueHouseholds(currentRows());
  const rows        = currentRows();
  const dollars     = rows.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);
  const totalHours  = rows.reduce((s, r) => s + (Number(r.hours) || 0), 0);

  const breakdowns = [
    { title: 'Households by AMI Level',        field: 'amiPercent',     data: unique },
    { title: 'Households by Race & Ethnicity', field: 'reCode',         data: unique },
    { title: 'Sessions by Counseling Type',    field: 'counselingType', data: rows   },
    { title: 'Sessions by Counselor',          field: 'counselor',      data: rows   },
    { title: 'Female-Headed Households',       field: null,             count: unique.filter(r => r.femaleHeaded).length },
    { title: 'Hispanic/Latino Households',     field: null,             count: unique.filter(r => r.hispanic).length    },
  ];

  const breakdownHtml = breakdowns.map(b => {
    if (b.field === null) {
      return `<div class="rpt-section"><h3>${b.title}</h3><p>${b.count}</p></div>`;
    }
    const counts = {};
    b.data.forEach(r => {
      const raw = r[b.field];
      const k = b.field === 'amiPercent'
        ? (amiCategory(raw) || '(blank)')
        : ((raw || '').trim() || '(blank)');
      counts[k] = (counts[k] || 0) + 1;
    });
    const rows2 = Object.entries(counts).sort((a, c) => c[1] - a[1]);
    return `<div class="rpt-section"><h3>${b.title}</h3><table>
      ${rows2.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
    </table></div>`;
  }).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Counseling Log Report</title>
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
  <h1>Home Stabilization Program — Counseling Log Report</h1>
  <div class="subtitle">${filterDesc} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString()}</div>
  <div class="stats">
    <div class="stat"><div class="stat-val">${unique.length}</div><div class="stat-lbl">Unique Households</div></div>
    <div class="stat"><div class="stat-val">${rows.length}</div><div class="stat-lbl">Total Sessions</div></div>
    <div class="stat"><div class="stat-val">${totalHours % 1 === 0 ? totalHours.toLocaleString() : totalHours.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:2})}</div><div class="stat-lbl">Total Hours</div></div>
    <div class="stat"><div class="stat-val">$${dollars.toLocaleString('en-US',{minimumFractionDigits:2})}</div><div class="stat-lbl">Dollars Awarded</div></div>
  </div>
  <div class="rpt-grid">${breakdownHtml}</div>
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`);
  win.document.close();
}

function populateFilters() {
  appendOptions('fMonth', MONTHS);
  appendOptions('fType',  COUNSELING_TYPES);
  appendOptions('fAmi',   AMI_LEVELS);
  appendOptions('fRe',    RE_CODES);
}

function populateCounselorFilter() {
  const sel = document.getElementById('fCounselor');
  // Collect unique counselor values from all records, sorted
  const names = [...new Set(
    allRows.map(r => (r.counselor || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  // Remove any previously added options (keep "All" at index 0)
  while (sel.options.length > 1) sel.remove(1);

  names.forEach(name => {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
}

function appendOptions(id, list) {
  const sel = document.getElementById(id);
  list.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  });
}

async function loadLog() {
  document.getElementById('tableBody').innerHTML =
    '<tr><td colspan="11" style="text-align:center;padding:2rem;color:var(--text-muted)">Loading…</td></tr>';
  // No orderBy — avoids Firestore excluding records where counselingDate is null
  const snap = await getDocs(collection(db, 'counselingLog'));
  allRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  allRows.sort((a, b) => toDate(b.counselingDate) - toDate(a.counselingDate));
  populateCounselorFilter();
  applyFilters();
}

function applyFilters() {
  const v = {
    counselor: document.getElementById('fCounselor').value,
    start:     document.getElementById('fStart').value,
    end:       document.getElementById('fEnd').value,
    ami:       document.getElementById('fAmi').value,
    re:        document.getElementById('fRe').value,
    type:      document.getElementById('fType').value,
    status:    document.getElementById('fStatus').value.trim().toLowerCase(),
    month:     document.getElementById('fMonth').value,
    hasAmount: document.getElementById('fHasAmount').value,
  };

  let rows = allRows;
  if (v.counselor) rows = rows.filter(r => r.counselor === v.counselor);
  if (v.start)     rows = rows.filter(r => toDate(r.counselingDate) >= new Date(v.start));
  if (v.end)       rows = rows.filter(r => toDate(r.counselingDate) <= new Date(v.end + 'T23:59:59'));
  if (v.ami)       rows = rows.filter(r => amiCategory(r.amiPercent) === v.ami);
  if (v.re)        rows = rows.filter(r => r.reCode === v.re);
  if (v.type)      rows = rows.filter(r => r.counselingType === v.type);
  if (v.status)    rows = rows.filter(r => (r.caseStatus || '').toLowerCase().includes(v.status));
  if (v.month)     rows = rows.filter(r => r.sourceMonth === v.month);
  if (v.hasAmount === 'yes') rows = rows.filter(r => (Number(r.dollarsAwarded) || 0) > 0);
  if (v.hasAmount === 'no')  rows = rows.filter(r => !((Number(r.dollarsAwarded) || 0) > 0));

  _filteredRows = rows;
  renderTable(rows);
  renderStats(rows);
  document.getElementById('rowCount').textContent =
    rows.length === allRows.length
      ? `${rows.length} records`
      : `${rows.length} of ${allRows.length} records`;
}

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

function uniqueHouseholds(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = (r.rxNumber || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderStats(rows) {
  const unique      = uniqueHouseholds(rows);
  const dollars     = rows.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0);
  const totalHours  = rows.reduce((s, r) => s + (Number(r.hours) || 0), 0);

  document.getElementById('statHouseholds').textContent = unique.length;
  document.getElementById('statSessions').textContent   = rows.length;
  document.getElementById('statHours').textContent      =
    totalHours % 1 === 0
      ? totalHours.toLocaleString()
      : totalHours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  document.getElementById('statDollars').textContent    =
    '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  renderBreakdown('amiTable',         'amiPercent',     unique.map(r => ({ ...r, amiPercent: amiCategory(r.amiPercent) })));
  renderBreakdown('reTable',          'reCode',         unique);
  renderBreakdown('typeTable',        'counselingType', rows);
  renderBreakdown('counselorTable',   'counselor',      rows);
  renderBreakdown('outcomeTypeTable', 'awardType',      rows.filter(r => (Number(r.dollarsAwarded) || 0) > 0));
}

function getFilterDescription() {
  const parts = [];
  const month = document.getElementById('fMonth').value;
  const start = document.getElementById('fStart').value;
  const end   = document.getElementById('fEnd').value;
  const type  = document.getElementById('fType').value;
  const counselor = document.getElementById('fCounselor').value.trim();
  if (month)    parts.push(month);
  if (start)    parts.push(`From ${start}`);
  if (end)      parts.push(`To ${end}`);
  if (type)     parts.push(type);
  if (counselor) parts.push(counselor);
  return parts.length ? parts.join(' · ') : 'All Records';
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
    : '<tr><td colspan="2" style="padding:0.75rem;text-align:center;color:var(--text-muted)">No data</td></tr>';
}

function renderTable(rows) {
  const tbody = document.getElementById('tableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:2rem;color:var(--text-muted)">No records found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const date   = r.counselingDate ? toDate(r.counselingDate).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '—';
    const amount = r.dollarsAwarded != null ? '$' + Number(r.dollarsAwarded).toFixed(2) : '—';
    const type   = r.counselingType || '';
    const badge  = type
      ? `<span class="badge badge-${type.toLowerCase()}">${type}</span>`
      : '—';

    const adminAccess = isAdmin(currentProfile);

    const actions = [
      `<a class="btn btn-sm btn-secondary" href="edit-entry.html?id=${r.id}">Edit</a>`,
      adminAccess ? `<button class="btn btn-sm btn-danger" data-delete="${r.id}">Del</button>` : ''
    ].join('');

    return `<tr class="clickable-row" data-id="${r.id}">
      <td>${r.rxNumber || '—'}</td>
      <td style="white-space:nowrap">${date}</td>
      <td>${r.counselor || '—'}</td>
      <td>${r.clientName || '—'}</td>
      <td>${badge}</td>
      <td>${r.amiPercent || '—'}</td>
      <td style="font-size:0.8rem">${r.reCode || '—'}</td>
      <td style="text-align:right">${r.hours ?? '—'}</td>
      <td style="text-align:right">${amount}</td>
      <td>${r.outcome || '—'}</td>
      <td><div style="display:flex;gap:4px;white-space:nowrap">${actions}</div></td>
    </tr>`;
  }).join('');

  // Row click → edit (ignore action button clicks)
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      window.location.href = `edit-entry.html?id=${tr.dataset.id}`;
    });
  });

  // Delete buttons
  tbody.querySelectorAll('button[data-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this record? This cannot be undone.')) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await deleteDoc(doc(db, 'counselingLog', btn.dataset.delete));
        await loadLog();
      } catch (err) {
        alert('Delete failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Del';
      }
    });
  });
}
