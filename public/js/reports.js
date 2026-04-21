import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { MONTHS, AMI_LEVELS, RE_CODES, RE_CODE_LABELS } from './data.js';
import {
  collection, collectionGroup, getDocs, query, where, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let reportData = null; // { unique, rows, month, year }

requireAuth(async (user, profile) => {
  setupNav(profile, 'reports');

  // Populate month select
  const monthSel = document.getElementById('reportMonth');
  MONTHS.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    monthSel.appendChild(o);
  });
  monthSel.value = MONTHS[new Date().getMonth()];
  document.getElementById('reportYear').value   = new Date().getFullYear();
  document.getElementById('reportPerson').value = profile.name || '';

  monthSel.addEventListener('change', loadMonth);
  document.getElementById('reportYear').addEventListener('change', loadMonth);

  document.getElementById('printCdbgBtn').addEventListener('click', () => window.print());

  await loadMonth();

  // Court report
  document.getElementById('courtReportYear').value = new Date().getFullYear();
  document.getElementById('loadCourtReportBtn').addEventListener('click', loadCourtReport);
});

// ── Load & render CDBG data ───────────────────────────────────────────────────

function toDate(ts) {
  if (!ts) return null;
  return ts.toDate ? ts.toDate() : new Date(ts);
}

async function loadMonth() {
  const month  = document.getElementById('reportMonth').value;
  const year   = parseInt(document.getElementById('reportYear').value, 10);
  const card   = document.getElementById('cdbgCard');
  const status = document.getElementById('reportStatus');

  if (!month || !year) { card.style.display = 'none'; return; }

  status.textContent = 'Loading data…';
  card.style.display = 'none';

  const snap = await getDocs(query(collection(db, 'counselingLog')));
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Filter by month name AND year
  rows = rows.filter(r => {
    if (r.sourceMonth !== month) return false;
    const d = toDate(r.counselingDate);
    if (!d) return true; // no date — keep if month name matches
    return d.getFullYear() === year;
  });

  // Unique households: deduplicate by caseNo, falling back to clientName
  const seen   = new Set();
  const unique = rows.filter(r => {
    const key = (r.caseNo || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  reportData = { unique, rows, month, year };

  status.textContent =
    `${unique.length} unique household${unique.length !== 1 ? 's' : ''} · ${rows.length} session${rows.length !== 1 ? 's' : ''} for ${month} ${year}`;

  renderPreviews(unique);
  updatePrintArea(month, year);

  card.style.display = 'block';
}

// ── Screen preview tables ─────────────────────────────────────────────────────

function renderPreviews(unique) {
  renderR1Preview(unique);
  renderR2Preview(unique);
}

function renderR1Preview(unique) {
  const counts = countByField(unique, 'amiPercent', AMI_LEVELS);
  const total  = Object.values(counts).reduce((s, n) => s + n, 0);
  document.getElementById('r1PreviewBody').innerHTML =
    AMI_LEVELS.map(level => `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;">${counts[level] || 0}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;">${amiLabel(level)}</td>
      </tr>`).join('') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;font-weight:700;">Total persons served</td>
    </tr>`;
}

function renderR2Preview(unique) {
  const counts   = countByField(unique, 'reCode', RE_CODES);
  const total    = Object.values(counts).reduce((s, n) => s + n, 0);
  const femaleCt = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('r2PreviewBody').innerHTML =
    RE_CODES.map(code => {
      const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
      return `<tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${counts[code] || 0}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-size:0.8rem;">${RE_CODE_LABELS[code] || code}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${hispCt}</td>
      </tr>`;
    }).join('') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;">Total Households served</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;"></td>
    </tr>
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;">${femaleCt}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;" colspan="2">Number of Female-Headed Households</td>
    </tr>`;
}

// ── Print-area population ─────────────────────────────────────────────────────

function updatePrintArea(month, year) {
  const { unique } = reportData;
  const today      = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const person     = document.getElementById('reportPerson').value;

  document.getElementById('cdbgCardSubtitle').textContent = `${month} ${year}`;
  document.getElementById('printMonthLine').textContent   = `Report Month: ${month} ${year}`;
  document.getElementById('printPersonLine').textContent  = `Completed By: ${person}`;
  document.getElementById('printDateLine').textContent    = `Date Prepared: ${today}`;

  // Report 1 print table
  const counts1 = countByField(unique, 'amiPercent', AMI_LEVELS);
  const total1  = Object.values(counts1).reduce((s, n) => s + n, 0);
  document.getElementById('r1PrintBody').innerHTML =
    AMI_LEVELS.map(level => `
      <tr>
        <td class="num">${counts1[level] || 0}</td>
        <td>${amiLabel(level)}</td>
      </tr>`).join('') + `
    <tr style="font-weight:700;">
      <td class="num">${total1}</td>
      <td>Total persons served</td>
    </tr>`;

  // Report 2 print table
  const counts2  = countByField(unique, 'reCode', RE_CODES);
  const total2   = Object.values(counts2).reduce((s, n) => s + n, 0);
  const femaleCt = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('r2PrintBody').innerHTML =
    RE_CODES.map(code => {
      const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
      return `<tr>
        <td class="num">${counts2[code] || 0}</td>
        <td>${RE_CODE_LABELS[code] || code}</td>
        <td class="num">${hispCt}</td>
      </tr>`;
    }).join('') + `
    <tr style="font-weight:700;">
      <td class="num">${total2}</td><td>Total Households served</td><td></td>
    </tr>
    <tr style="font-weight:700;">
      <td class="num">${femaleCt}</td><td colspan="2">Number of Female-Headed Households</td>
    </tr>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countByField(rows, field, orderedKeys) {
  const counts = {};
  orderedKeys.forEach(k => { counts[k] = 0; });
  rows.forEach(r => { if (r[field] in counts) counts[r[field]]++; });
  return counts;
}

function amiLabel(level) {
  const map = {
    'Extremely Low':    'Extremely Low (or Very Low)',
    'Low':              'Low',
    'Moderate':         'Moderate (or Low-Moderate)',
    'Non Low-Moderate': 'Non Low-Moderate',
  };
  return map[level] || level;
}

// ── Court Appearance Report ───────────────────────────────────────────────────

async function loadCourtReport() {
  const year     = parseInt(document.getElementById('courtReportYear').value, 10);
  const resultEl = document.getElementById('courtReportResult');

  if (!year || isNaN(year)) {
    resultEl.innerHTML = '<span style="color:var(--danger);">Please enter a valid year.</span>';
    return;
  }

  resultEl.textContent = 'Loading…';
  document.getElementById('loadCourtReportBtn').disabled = true;

  try {
    const startDate = new Date(`${year}-01-01T00:00:00`);
    const endDate   = new Date(`${year}-12-31T23:59:59`);

    const snap = await getDocs(
      query(
        collectionGroup(db, 'sessions'),
        where('date', '>=', startDate),
        where('date', '<=', endDate),
        orderBy('date', 'asc')
      )
    );

    const sessions = snap.docs
      .map(d => ({ id: d.id, clientId: d.ref.parent.parent.id, ...d.data() }))
      .filter(s => (s.caseStatus || '').startsWith('Court'));

    if (!sessions.length) {
      resultEl.innerHTML = `<span style="color:var(--text-muted);">No court appearances logged in ${year}.</span>`;
      return;
    }

    const groups = {};
    for (const s of sessions) {
      const dateMs  = s.date?.toDate ? s.date.toDate() : new Date(s.date);
      const dateStr = dateMs.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      const county  = (s.caseStatus || '').replace(/^Court\s*[—-]\s*/i, '').trim() || 'Unknown County';
      const key     = `${dateMs.toISOString().split('T')[0]}|${county}`;

      if (!groups[key]) groups[key] = { dateStr, dateMs, county, counselors: new Set(), clients: [] };
      const g = groups[key];
      if (s.counselor) g.counselors.add(s.counselor);
      const name = (s.clientName || '').trim();
      if (name && !g.clients.includes(name)) g.clients.push(name);
    }

    const sorted       = Object.values(groups).sort((a, b) => b.dateMs - a.dateMs);
    const totalDates   = sorted.length;
    const totalClients = sorted.reduce((s, g) => s + g.clients.length, 0);

    resultEl.innerHTML = `
      <div style="margin-bottom:0.75rem;font-size:0.8125rem;color:var(--text-muted);">
        <strong style="color:var(--text);">${totalDates}</strong> court date${totalDates !== 1 ? 's' : ''} &nbsp;·&nbsp;
        <strong style="color:var(--text);">${totalClients}</strong> total client appearances in ${year}
      </div>
      <table style="font-size:0.875rem;">
        <thead>
          <tr>
            <th>Court Date</th><th>County</th>
            <th style="text-align:right;"># Clients</th>
            <th>Counselor(s)</th><th>Clients</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(g => `
            <tr>
              <td style="white-space:nowrap;">${esc(g.dateStr)}</td>
              <td>${esc(g.county)}</td>
              <td style="text-align:right;font-weight:600;">${g.clients.length}</td>
              <td>${esc([...g.counselors].join(', ') || '—')}</td>
              <td style="font-size:0.8rem;color:var(--text-muted);">${
                g.clients.length ? g.clients.map(n => esc(titleCase(n))).join(', ') : '—'
              }</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--danger);">Failed to load: ${esc(err.message)}</span>`;
  } finally {
    document.getElementById('loadCourtReportBtn').disabled = false;
  }
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function titleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
