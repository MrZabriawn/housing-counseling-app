import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { MONTHS } from './data.js';
import {
  collection, collectionGroup, getDocs, query, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const SS = 'dashboardFilters'; // sessionStorage key

requireAuth(async (user, profile) => {
  setupNav(profile, 'dashboard');

  // Populate month filter
  const monthSel = document.getElementById('filterMonth');
  MONTHS.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    monthSel.appendChild(o);
  });

  // Populate year filter (current year back to 2020)
  const yearSel  = document.getElementById('filterYear');
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y >= 2020; y--) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y;
    yearSel.appendChild(o);
  }

  // Populate counselor filter
  const counselorSel = document.getElementById('filterCounselor');
  try {
    const cSnap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    cSnap.docs.forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      counselorSel.appendChild(o);
    });
  } catch (_) { /* counselors collection optional */ }

  // Restore saved filters from sessionStorage so navigating away and back
  // keeps whatever the user had selected.
  restoreFilters();

  await loadDashboard();

  document.getElementById('filterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    saveFilters();
    await loadDashboard();
  });

  document.getElementById('clearFilters').addEventListener('click', () => {
    document.getElementById('filterMonth').value     = '';
    document.getElementById('filterYear').value      = '';
    document.getElementById('filterDateStart').value = '';
    document.getElementById('filterDateEnd').value   = '';
    document.getElementById('filterCounselor').value = '';
    sessionStorage.removeItem(SS);
    loadDashboard();
  });
});

function saveFilters() {
  sessionStorage.setItem(SS, JSON.stringify({
    month:     document.getElementById('filterMonth').value,
    year:      document.getElementById('filterYear').value,
    dateStart: document.getElementById('filterDateStart').value,
    dateEnd:   document.getElementById('filterDateEnd').value,
    counselor: document.getElementById('filterCounselor').value,
  }));
}

function restoreFilters() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SS) || 'null');
    if (!saved) return;
    document.getElementById('filterMonth').value     = saved.month     || '';
    document.getElementById('filterYear').value      = saved.year      || '';
    document.getElementById('filterDateStart').value = saved.dateStart || '';
    document.getElementById('filterDateEnd').value   = saved.dateEnd   || '';
    document.getElementById('filterCounselor').value = saved.counselor || '';
  } catch (_) {}
}

function toDate(ts) {
  if (!ts) return new Date(0);
  return ts.toDate ? ts.toDate() : new Date(ts);
}

function uniqueHouseholds(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = (r.caseNo || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadDashboard() {
  ['statHouseholds','statSessions','statHours','statDollars','statFemale','statHispanic'].forEach(id => {
    document.getElementById(id).textContent = '…';
  });

  const monthVal     = document.getElementById('filterMonth').value;
  const yearVal      = parseInt(document.getElementById('filterYear').value, 10) || 0;
  const startVal     = document.getElementById('filterDateStart').value;
  const endVal       = document.getElementById('filterDateEnd').value;
  const counselorVal = document.getElementById('filterCounselor').value;

  const hasDateRange = !!(startVal || endVal);
  const start = startVal ? new Date(startVal + 'T00:00:00') : null;
  const end   = endVal   ? new Date(endVal   + 'T23:59:59') : null;

  // ── counselingLog (demographics / CDBG data) ──────────────────────────────
  const snap = await getDocs(collection(db, 'counselingLog'));
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (hasDateRange) {
    rows = rows.filter(r => {
      if (!r.counselingDate) return false;
      const d = toDate(r.counselingDate);
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    });
  } else if (monthVal) {
    rows = rows.filter(r => {
      if (r.sourceMonth !== monthVal) return false;
      if (yearVal) {
        const d = toDate(r.counselingDate);
        if (d.getTime() === 0) return true;
        return d.getFullYear() === yearVal;
      }
      return true;
    });
  } else if (yearVal) {
    rows = rows.filter(r => {
      const d = toDate(r.counselingDate);
      if (d.getTime() === 0) return false;
      return d.getFullYear() === yearVal;
    });
  }

  if (counselorVal) {
    rows = rows.filter(r => (r.counselor || '') === counselorVal);
  }

  // ── Sessions subcollection — Total Hours ──────────────────────────────────
  // Always load all sessions and filter client-side to avoid needing a
  // composite Firestore index on collectionGroup + date range.
  let totalHours = 0;
  try {
    const sessSnap = await getDocs(collectionGroup(db, 'sessions'));
    sessSnap.docs.forEach(d => {
      const s = d.data();
      const sDate = toDate(s.date);

      if (hasDateRange) {
        if (start && sDate < start) return;
        if (end   && sDate > end)   return;
      } else {
        if (monthVal && MONTHS[sDate.getMonth()] !== monthVal) return;
        if (yearVal  && sDate.getFullYear() !== yearVal)        return;
      }

      if (counselorVal && (s.counselor || '') !== counselorVal) return;
      totalHours += Number(s.hours) || 0;
    });
  } catch (_) {
    totalHours = null; // show N/A only if the query itself fails
  }

  renderStats(rows, totalHours);
}

function renderStats(rows, totalHours) {
  const unique = uniqueHouseholds(rows);

  document.getElementById('statHouseholds').textContent = unique.length;
  document.getElementById('statSessions').textContent   = rows.length;
  document.getElementById('statHours').textContent      =
    totalHours === null
      ? 'N/A'
      : totalHours % 1 === 0
        ? totalHours.toLocaleString()
        : totalHours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  document.getElementById('statDollars').textContent =
    '$' + rows.reduce((s, r) => s + (Number(r.dollarsAwarded) || 0), 0)
              .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('statFemale').textContent   = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('statHispanic').textContent = unique.filter(r => r.hispanic).length;

  renderBreakdown('amiTable',       'amiPercent',     unique);
  renderBreakdown('reTable',        'reCode',         unique);
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

  tbody.innerHTML = entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}
