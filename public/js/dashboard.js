import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { MONTHS } from './data.js';
import {
  collection, getDocs, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

requireAuth(async (user, profile) => {
  setupNav(profile, 'dashboard');

  // Populate month filter
  const monthSel = document.getElementById('filterMonth');
  MONTHS.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    monthSel.appendChild(o);
  });
  monthSel.value = '';

  await loadDashboard();

  document.getElementById('filterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await loadDashboard();
  });
  document.getElementById('clearFilters').addEventListener('click', () => {
    document.getElementById('filterMonth').value = '';
    document.getElementById('filterDateStart').value = '';
    document.getElementById('filterDateEnd').value = '';
    loadDashboard();
  });
});

async function loadDashboard() {
  // Reset stat cards
  ['statHouseholds','statSessions','statDollars','statFemale','statHispanic'].forEach(id => {
    document.getElementById(id).textContent = '…';
  });

  const monthVal = document.getElementById('filterMonth').value;
  const startVal = document.getElementById('filterDateStart').value;
  const endVal   = document.getElementById('filterDateEnd').value;

  // Fetch all records — no orderBy so null-date records are included
  const snap = await getDocs(collection(db, 'counselingLog'));
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const hasDateRange = startVal || endVal;

  if (hasDateRange) {
    // Explicit date range — filter by counselingDate, skip records with no date
    const start = startVal ? new Date(startVal + 'T00:00:00') : null;
    const end   = endVal   ? new Date(endVal   + 'T23:59:59') : null;
    rows = rows.filter(r => {
      if (!r.counselingDate) return false;
      const d = toDate(r.counselingDate);
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    });
  } else if (monthVal) {
    // Month selected — filter by sourceMonth label only, all years
    rows = rows.filter(r => r.sourceMonth === monthVal);
  }
  // No filters = show all

  renderStats(rows);
}

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

// Unique households: deduplicate by caseNo, falling back to clientName
function uniqueHouseholds(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = (r.caseNo || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderStats(rows) {
  const unique = uniqueHouseholds(rows);

  document.getElementById('statHouseholds').textContent = unique.length;
  document.getElementById('statSessions').textContent   = rows.length;
  document.getElementById('statDollars').textContent    =
    '$' + rows.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0)
              .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('statFemale').textContent   = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('statHispanic').textContent = unique.filter(r => r.hispanic).length;

  renderBreakdown('amiTable',       'amiPercent',    unique);
  renderBreakdown('reTable',        'reCode',        unique);
  renderBreakdown('typeTable',      'counselingType', rows);
  renderBreakdown('counselorTable', 'counselor',      rows);
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
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="2" style="padding:0.75rem;text-align:center;color:var(--text-muted)">No data</td></tr>';
    return;
  }

  tbody.innerHTML = entries
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join('');
}
