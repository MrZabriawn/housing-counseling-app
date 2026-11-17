import { db } from './firebase-config.js';
import { QREW_API_KEY } from './app-config.js';
import { requireAuth, setupNav } from './auth.js?v=2';
import { MONTHS, amiCategory, reCodeDisplay } from './data.js';
import {
  collection, collectionGroup, getDocs, query, orderBy, where, limit
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

  await Promise.all([loadDashboard(), loadBillingSummary(), loadBuyerReadySection(), loadRepairSurveySection()]);

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
    const key = r._clientId || (r.caseNo || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadDashboard() {
  ['statHouseholds','statSessions','statHours','statDollars','statFemale','statHispanic','statFTHB','statGroupEd','statClosures','statAvgDays','statDirectAmt','statOutcomeAmt','statReferredOut','statWorkshopHC'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });

  const monthVal     = document.getElementById('filterMonth').value;
  const yearVal      = parseInt(document.getElementById('filterYear').value, 10) || 0;
  const startVal     = document.getElementById('filterDateStart').value;
  const endVal       = document.getElementById('filterDateEnd').value;
  const counselorVal = document.getElementById('filterCounselor').value;

  const hasDateRange = !!(startVal || endVal);
  const start = startVal ? new Date(startVal + 'T00:00:00') : null;
  const end   = endVal   ? new Date(endVal   + 'T23:59:59') : null;

  // Load clients, all sessions, legacy counselingLog, and workshops in parallel
  const [clientsSnap, sessionsSnap, logSnap, workshopsSnap] = await Promise.all([
    getDocs(collection(db, 'clients')),
    getDocs(collectionGroup(db, 'sessions')),
    getDocs(collection(db, 'counselingLog')),
    getDocs(collection(db, 'workshops')),
  ]);

  // Build client demographics lookup
  const clientsMap = {};
  clientsSnap.docs.forEach(d => { clientsMap[d.id] = { id: d.id, ...d.data() }; });

  // Filter sessions client-side, enrich with demographics, accumulate hours
  let totalHours = 0;
  const sessionRows = [];

  sessionsSnap.docs.forEach(d => {
    const s     = d.data();
    const sDate = toDate(s.date);

    if (hasDateRange) {
      if (start && sDate < start) return;
      if (end   && sDate > end)   return;
    } else if (monthVal || yearVal) {
      if (monthVal && MONTHS[sDate.getMonth()] !== monthVal) return;
      if (yearVal  && sDate.getFullYear() !== yearVal)        return;
    }

    const clientId     = d.ref.parent.parent.id;
    const client       = clientsMap[clientId] || {};
    const rowCounselor = (s.counselor || client.counselor || '').trim();
    if (counselorVal && rowCounselor.toLowerCase() !== counselorVal.toLowerCase()) return;
    totalHours += Number(s.hours) || 0;

    sessionRows.push({
      _clientId:          clientId,
      clientName:         client.clientName || '',
      counselor:          s.counselor || client.counselor || '',
      counselingType:     s.counselingType || client.counselingType || '',
      amiPercent:         client.amiPercent || '',
      reCode:             client.reCode || '',
      hispanic:           !!client.hispanic,
      femaleHeaded:       !!client.femaleHeaded,
      firstTimeHomebuyer: !!client.firstTimeHomebuyer,
      referralSource:     client.referralSource || '',
      county:             client.county || '',
      contactType:        s.contactType || '',
      dollarsAwarded:     Number(s.dollarsAwarded) || 0,
      counselingDate:     s.date,
      workshopId:         s.workshopId || '',
    });
  });

  // Legacy counselingLog entries — apply same filters, exclude names already in sessions
  let logRows = logSnap.docs.map(d => ({ _clientId: null, id: d.id, ...d.data() }));

  if (hasDateRange) {
    logRows = logRows.filter(r => {
      if (!r.counselingDate) return false;
      const d = toDate(r.counselingDate);
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    });
  } else if (monthVal) {
    logRows = logRows.filter(r => {
      if (r.sourceMonth !== monthVal) return false;
      if (yearVal) {
        const d = toDate(r.counselingDate);
        if (!d || d.getTime() === 0) return true;
        return d.getFullYear() === yearVal;
      }
      return true;
    });
  } else if (yearVal) {
    logRows = logRows.filter(r => {
      const d = toDate(r.counselingDate);
      if (!d || d.getTime() === 0) return false;
      return d.getFullYear() === yearVal;
    });
  }

  if (counselorVal) {
    logRows = logRows.filter(r => (r.counselor || '').trim().toLowerCase() === counselorVal.toLowerCase());
  }

  const sessionNames = new Set(
    sessionRows.map(r => (r.clientName || '').toLowerCase().trim()).filter(Boolean)
  );
  const legacyOnly = logRows.filter(r => {
    const name = (r.clientName || '').toLowerCase().trim();
    return name && !sessionNames.has(name);
  });

  // Compute closed clients, filtered by the same date range applied to closureDate
  const closedClients = clientsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => {
      if (c.status !== 'closed' || !c.closureDate) return false;
      const d = toDate(c.closureDate);
      if (hasDateRange) {
        if (start && d < start) return false;
        if (end   && d > end)   return false;
      } else if (monthVal || yearVal) {
        if (monthVal && MONTHS[d.getMonth()] !== monthVal) return false;
        if (yearVal  && d.getFullYear() !== yearVal) return false;
      }
      if (counselorVal && (c.counselor || '').trim().toLowerCase() !== counselorVal.toLowerCase()) return false;
      return true;
    });

  // Sum workshop attendeeCount for the filtered period
  let workshopHeadcount = 0;
  workshopsSnap.docs.forEach(d => {
    const w = d.data();
    const wDate = toDate(w.date);
    if (hasDateRange) {
      if (start && wDate < start) return;
      if (end   && wDate > end)   return;
    } else if (monthVal || yearVal) {
      if (monthVal && MONTHS[wDate.getMonth()] !== monthVal) return;
      if (yearVal  && wDate.getFullYear() !== yearVal)       return;
    }
    workshopHeadcount += Number(w.attendeeCount) || 0;
  });

  renderStats([...sessionRows, ...legacyOnly], totalHours, closedClients, workshopHeadcount);
}

function renderStats(rows, totalHours, closedClients = [], workshopHeadcount = 0) {
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

  const fthbEl = document.getElementById('statFTHB');
  if (fthbEl) fthbEl.textContent = unique.filter(r => r.firstTimeHomebuyer).length;

  const groupEdSessions = rows.filter(r => r.counselingType === 'Group Education');
  const groupEdAttendees = new Set(groupEdSessions.map(r => r._clientId)).size;
  const groupEdEl = document.getElementById('statGroupEd');
  if (groupEdEl) groupEdEl.textContent = groupEdAttendees;

  const whcEl = document.getElementById('statWorkshopHC');
  if (whcEl) whcEl.textContent = workshopHeadcount;

  renderBreakdown('amiTable',         'amiPercent',     unique.map(r => ({ ...r, amiPercent: amiCategory(r.amiPercent) })));
  renderBreakdown('reTable',          'reCode',         unique.map(r => ({ ...r, reCode: reCodeDisplay(r.reCode) })));
  renderBreakdown('typeTable',        'counselingType', rows);
  renderBreakdown('counselorTable',   'counselor',      rows);
  renderBreakdown('countyTable',      'county',         unique);
  renderBreakdown('referralTable',    'referralSource', unique);
  renderBreakdown('contactTypeTable', 'contactType',    rows);

  // Closures stats
  const fmt = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const directAmt = closedClients.reduce((s, c) => {
    if (c.closureAwardType !== 'Direct Assistance') return s;
    if ((c.closureOutcome || '').startsWith('Purchased')) return s;
    return s + (Number(c.closureOutcomeValue) || 0);
  }, 0);
  const totalAmt = closedClients.reduce((s, c) => s + (Number(c.closureOutcomeValue) || 0), 0);

  document.getElementById('statClosures').textContent   = closedClients.length;
  document.getElementById('statDirectAmt').textContent  = fmt(directAmt);
  document.getElementById('statOutcomeAmt').textContent = fmt(totalAmt);

  const referredCount = closedClients.filter(c => c.referredToAgency === true).length;
  const referredEl = document.getElementById('statReferredOut');
  if (referredEl) referredEl.textContent = referredCount;

  const daysToClose = closedClients
    .map(c => {
      const intake   = c.intakeDate   ? toDate(c.intakeDate)   : null;
      const closure  = c.closureDate  ? toDate(c.closureDate)  : null;
      if (!intake || !closure || closure <= intake) return null;
      return (closure - intake) / (1000 * 60 * 60 * 24);
    })
    .filter(d => d !== null);
  const avgDays = daysToClose.length
    ? Math.round(daysToClose.reduce((s, d) => s + d, 0) / daysToClose.length)
    : null;
  document.getElementById('statAvgDays').textContent = avgDays !== null ? avgDays : '—';

  renderBreakdown('closureTypeTable',    'counselingType',    closedClients);
  renderBreakdown('closureAwardTable',   'closureAwardType',  closedClients);
  renderBreakdown('closureOutcomeTable', 'closureOutcome',    closedClients);
}

async function loadBillingSummary() {
  const PROGRAMS = ['CHCI', 'HEMAP', 'HUD', 'JTBC', 'TMCRF'];
  const PROGRAM_COLORS = {
    CHCI:  'background:#dbeafe;color:#1e40af',
    HEMAP: 'background:#ffedd5;color:#c2410c',
    HUD:   'background:#ede9fe;color:#6d28d9',
    JTBC:  'background:#ccfbf1;color:#0f766e',
    TMCRF: 'background:#ffe4e6;color:#be123c',
  };
  const fmtMoney = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  try {
    const [regSnap, allocSnap] = await Promise.all([
      getDocs(query(collection(db, 'billingRegister'), orderBy('createdAt', 'desc'), limit(50))),
      getDocs(query(collection(db, 'allocations'), orderBy('effectiveDate', 'desc'))),
    ]);

    const entries = regSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const allocations = allocSnap.docs.map(d => d.data());

    // Most recent allocation per program
    const latestAlloc = {};
    allocations.forEach(a => {
      if (!latestAlloc[a.program]) latestAlloc[a.program] = Number(a.amount) || 0;
    });

    // Totals per program from register
    const billedByProg = {}, paidByProg = {};
    entries.forEach(e => {
      if (e.status === 'void') return;
      billedByProg[e.program] = (billedByProg[e.program] || 0) + (Number(e.amount) || 0);
      if (e.status === 'paid') {
        paidByProg[e.program] = (paidByProg[e.program] || 0) + (Number(e.paidAmount ?? e.amount) || 0);
      }
    });

    const grid = document.getElementById('billingAllocGrid');
    if (grid) {
      grid.innerHTML = PROGRAMS.map(prog => {
        const allocated = latestAlloc[prog] || 0;
        const billed    = billedByProg[prog] || 0;
        const paid      = paidByProg[prog] || 0;
        const pct       = allocated > 0 ? Math.min(100, Math.round((billed / allocated) * 100)) : 0;
        const barColor  = pct >= 100 ? '#dc2626' : pct >= 80 ? '#f59e0b' : '#22c55e';
        const badgeStyle = PROGRAM_COLORS[prog] || 'background:#f1f5f9;color:#374151';
        return `<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:0.85rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem;">
            <span style="display:inline-block;padding:0.15em 0.6em;border-radius:4px;font-size:0.72rem;font-weight:700;${badgeStyle}">${prog}</span>
            ${allocated > 0 ? `<span style="font-size:0.72rem;color:var(--text-muted);">${pct}% used</span>` : ''}
          </div>
          ${allocated > 0 ? `<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:0.5rem;">
            <div style="height:100%;background:${barColor};border-radius:3px;width:${pct}%;transition:width 0.3s;"></div>
          </div>` : ''}
          <div style="font-size:0.78rem;color:var(--text-muted);display:flex;flex-direction:column;gap:0.15rem;">
            ${allocated > 0 ? `<div>Allocated: <strong>${fmtMoney(allocated)}</strong></div>` : '<div style="font-style:italic;">No allocation set</div>'}
            <div>Billed: <strong>${fmtMoney(billed)}</strong></div>
            <div>Paid: <strong>${fmtMoney(paid)}</strong></div>
          </div>
        </div>`;
      }).join('');
    }

    // Recent 6 entries table
    const recent = entries.slice(0, 6);
    const recentEl = document.getElementById('billingRecentRows');
    if (recentEl) {
      if (!recent.length) {
        recentEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No billing entries yet.</p>';
      } else {
        const statusPill = s => {
          const styles = { billed: 'background:#dbeafe;color:#1e40af', paid: 'background:#dcfce7;color:#15803d', void: 'background:#f1f5f9;color:#64748b' };
          const label = s === 'billed' ? 'Billed' : s === 'paid' ? 'Paid' : 'Void';
          return `<span style="display:inline-block;padding:0.1em 0.55em;border-radius:999px;font-size:0.7rem;font-weight:700;${styles[s] || ''}">${label}</span>`;
        };
        recentEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
          <thead><tr style="color:var(--text-muted);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;">
            <th style="padding:0.3rem 0.6rem;border-bottom:1px solid var(--border);text-align:left;">Program</th>
            <th style="padding:0.3rem 0.6rem;border-bottom:1px solid var(--border);text-align:left;">Month</th>
            <th style="padding:0.3rem 0.6rem;border-bottom:1px solid var(--border);text-align:right;">Amount</th>
            <th style="padding:0.3rem 0.6rem;border-bottom:1px solid var(--border);text-align:left;">Status</th>
          </tr></thead>
          <tbody>${recent.map(e => {
            const badgeStyle = PROGRAM_COLORS[e.program] || 'background:#f1f5f9;color:#374151';
            return `<tr>
              <td style="padding:0.4rem 0.6rem;border-bottom:1px solid var(--border);"><span style="display:inline-block;padding:0.1em 0.5em;border-radius:4px;font-size:0.7rem;font-weight:700;${badgeStyle}">${e.program}</span></td>
              <td style="padding:0.4rem 0.6rem;border-bottom:1px solid var(--border);">${e.billingMonth || '—'}</td>
              <td style="padding:0.4rem 0.6rem;border-bottom:1px solid var(--border);text-align:right;">${fmtMoney(e.amount)}</td>
              <td style="padding:0.4rem 0.6rem;border-bottom:1px solid var(--border);">${statusPill(e.status)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
      }
    }
  } catch (err) {
    const grid = document.getElementById('billingAllocGrid');
    if (grid) grid.innerHTML = `<div style="color:var(--text-muted);font-size:0.875rem;padding:1rem;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);grid-column:1/-1;text-align:center;">Could not load billing data.</div>`;
  }
}

async function loadBuyerReadySection() {
  const el = document.getElementById('buyerReadySection');
  if (!el) return;
  try {
    const snap = await getDocs(collection(db, 'ccaList'));
    const all = snap.docs.map(d => d.data());

    const pipeline = all.filter(r => r.status !== 'closed' && r.status !== 'dnp');
    const closed   = all.filter(r => r.status === 'closed');
    const disbursed = closed.reduce((s, r) => s + (Number(r.ccaAmountProvided) || 0), 0);
    const awardsWithAmt = closed.filter(r => Number(r.ccaAmountProvided) > 0);
    const avgAward = awardsWithAmt.length
      ? disbursed / awardsWithAmt.length
      : 0;
    const workshopPct = all.length
      ? Math.round((all.filter(r => r.dpaWorkshopAttended).length / all.length) * 100)
      : 0;

    const fmtMoney = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
        <h3 style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);margin:0;">Buyer Ready (DPA / CCA)</h3>
        <a href="programs.html?tab=buyer-ready" style="font-size:0.8125rem;color:var(--primary);text-decoration:none;">View Pipeline →</a>
      </div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Active Pipeline</div>
          <div class="stat-value">${pipeline.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Closed</div>
          <div class="stat-value">${closed.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Disbursed</div>
          <div class="stat-value" style="font-size:1.3rem;">${fmtMoney(disbursed)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Award</div>
          <div class="stat-value" style="font-size:1.3rem;">${avgAward > 0 ? fmtMoney(avgAward) : '—'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Attended Workshop</div>
          <div class="stat-value">${workshopPct}%</div>
        </div>
      </div>`;
  } catch (_) {
    const el2 = document.getElementById('buyerReadySection');
    if (el2) el2.innerHTML = '';
  }
}

async function loadRepairSurveySection() {
  const el = document.getElementById('repairSurveySection');
  if (!el) return;
  if (!QREW_API_KEY) return;
  try {
    const resp = await fetch(
      'https://workforce.housingopps.org/api/survey-results?all=1',
      { headers: { 'X-Api-Key': QREW_API_KEY } }
    );
    if (!resp.ok) { el.innerHTML = ''; return; }
    const { surveys = [] } = await resp.json();
    if (!surveys.length) { el.innerHTML = ''; return; }

    const count    = surveys.length;
    const avgSat   = surveys.reduce((s, r) => s + (Number(r.q1_satisfaction) || 0), 0) / count;
    const pctRec   = Math.round(surveys.filter(r => r.q6_recommend === 'yes').length / count * 100);
    const pctAddr  = Math.round(surveys.filter(r => r.q4_addressed === 'yes' || r.q4_addressed === 'partly').length / count * 100);
    const flagged  = surveys.filter(r => r.flagged).length;

    const stars = n => {
      const full = Math.round(n);
      return '★'.repeat(full) + '☆'.repeat(5 - full);
    };

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
        <h3 style="font-size:0.8rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);margin:0;">Repair Ready — Client Satisfaction</h3>
        <span style="font-size:0.78rem;color:var(--text-muted);">${count} response${count !== 1 ? 's' : ''}</span>
      </div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Avg Satisfaction</div>
          <div class="stat-value" style="font-size:1.3rem;">${avgSat.toFixed(1)}<span style="font-size:0.9rem;color:var(--text-muted);">/5</span></div>
          <div style="font-size:1rem;color:#f59e0b;letter-spacing:0.05em;">${stars(avgSat)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Would Recommend</div>
          <div class="stat-value">${pctRec}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Problem Addressed</div>
          <div class="stat-value">${pctAddr}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Flagged for Follow-up</div>
          <div class="stat-value" style="${flagged > 0 ? 'color:var(--danger,#dc2626)' : ''}">${flagged}</div>
        </div>
      </div>`;
  } catch (_) {
    const el2 = document.getElementById('repairSurveySection');
    if (el2) el2.innerHTML = '';
  }
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
