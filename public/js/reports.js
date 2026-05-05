import { db } from './firebase-config.js';
import { MONTHS, RE_CODES, RE_CODE_LABELS, amiCdbgCategory } from './data.js';
import {
  collection, collectionGroup, getDocs, query, where, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

let reportData = null; // { unique, rows, month, year }

export async function initCdbgReports(user, profile) {
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

  // Populate counselor filter
  try {
    const snap = await getDocs(query(collection(db, 'counselors'), orderBy('name')));
    const sel  = document.getElementById('reportCounselor');
    snap.docs.filter(d => d.data().active !== false).forEach(d => {
      const o = document.createElement('option');
      o.value = d.data().name; o.textContent = d.data().name;
      sel.appendChild(o);
    });
  } catch (_) {}

  monthSel.addEventListener('change', loadMonth);
  document.getElementById('reportYear').addEventListener('change', loadMonth);
  document.getElementById('reportCounselor').addEventListener('change', loadMonth);

  document.getElementById('printCdbgBtn').addEventListener('click', () => window.print());

  await loadMonth();

  // Court report
  document.getElementById('courtReportYear').value = new Date().getFullYear();
  document.getElementById('loadCourtReportBtn').addEventListener('click', loadCourtReport);
}

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

  const counselorVal = document.getElementById('reportCounselor').value;
  const monthIdx     = MONTHS.indexOf(month);
  const start        = new Date(year, monthIdx, 1);
  const end          = new Date(year, monthIdx + 1, 0, 23, 59, 59);

  // Load clients, all sessions (filter client-side — no index needed), and legacy counselingLog in parallel
  const [clientsSnap, sessionsSnap, logSnap] = await Promise.all([
    getDocs(collection(db, 'clients')),
    getDocs(collectionGroup(db, 'sessions')),
    getDocs(collection(db, 'counselingLog')),
  ]);

  // Build client demographics lookup
  const clientsMap = {};
  clientsSnap.docs.forEach(d => { clientsMap[d.id] = { id: d.id, ...d.data() }; });

  // Sessions → filter to the selected month/year (and optional counselor), enrich with client demographics
  const sessionRows = [];
  sessionsSnap.docs.forEach(d => {
    const s     = d.data();
    const sDate = toDate(s.date);
    if (!sDate) return;
    if (sDate < start || sDate > end) return;

    const clientId     = d.ref.parent.parent.id;
    const client       = clientsMap[clientId] || {};
    const rowCounselor = (s.counselor || client.counselor || '').trim();
    if (counselorVal && rowCounselor.toLowerCase() !== counselorVal.toLowerCase()) return;
    sessionRows.push({
      _clientId:      clientId,
      clientName:     client.clientName || '',
      caseNo:         (client.rxNumbers || [])[0] || '',
      counselor:      s.counselor || client.counselor || '',
      counselingType: client.counselingType || '',
      amiPercent:     client.amiPercent || '',
      reCode:         client.reCode || '',
      hispanic:       !!client.hispanic,
      femaleHeaded:   !!client.femaleHeaded,
      counselingDate: s.date,
    });
  });

  // Legacy counselingLog entries filtered to the selected month/year
  let logRows = logSnap.docs.map(d => ({ _clientId: null, id: d.id, ...d.data() }));
  logRows = logRows.filter(r => {
    if (r.sourceMonth !== month) return false;
    const d = toDate(r.counselingDate);
    if (!d) return true;
    return d.getFullYear() === year;
  });

  if (counselorVal) {
    logRows = logRows.filter(r => (r.counselor || '') === counselorVal);
  }

  // Only add legacy entries for clients not already captured via sessions
  const sessionNames = new Set(
    sessionRows.map(r => (r.clientName || '').toLowerCase().trim()).filter(Boolean)
  );
  const legacyOnly = logRows.filter(r => {
    const name = (r.clientName || '').toLowerCase().trim();
    return name && !sessionNames.has(name);
  });

  const allRows = [...sessionRows, ...legacyOnly];

  // Deduplicate to one row per household (clientId > clientName)
  const seen   = new Set();
  const unique = allRows.filter(r => {
    const key = r._clientId || (r.caseNo || '').trim() || (r.clientName || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  reportData = { unique, rows: allRows, month, year };

  const counselorLabel = counselorVal ? ` · ${counselorVal}` : '';
  status.textContent =
    `${unique.length} unique household${unique.length !== 1 ? 's' : ''} · ${allRows.length} session${allRows.length !== 1 ? 's' : ''} for ${month} ${year}${counselorLabel}`;

  renderPreviews(unique);
  updatePrintArea(month, year);

  card.style.display = 'block';
}

// ── Screen preview tables ─────────────────────────────────────────────────────

function renderPreviews(unique) {
  renderR1Preview(unique);
  renderR2Preview(unique);
  renderClientDetail(reportData.rows, unique);
}

const CDBG_AMI_LEVELS = ['Extremely Low', 'Low', 'Moderate', 'Non Low-Moderate'];

function countCdbgAmi(rows) {
  const counts = {};
  CDBG_AMI_LEVELS.forEach(k => { counts[k] = 0; });
  rows.forEach(r => {
    const cat = amiCdbgCategory(r.amiPercent);
    if (cat in counts) counts[cat]++;
  });
  return counts;
}

function renderR1Preview(unique) {
  const counts      = countCdbgAmi(unique);
  const unspecified = unique.filter(r => !CDBG_AMI_LEVELS.includes(amiCdbgCategory(r.amiPercent))).length;
  const total       = unique.length;
  document.getElementById('r1PreviewBody').innerHTML =
    CDBG_AMI_LEVELS.map(level => `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;">${counts[level] || 0}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;">${amiLabel(level)}</td>
      </tr>`).join('') +
    (unspecified > 0 ? `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;color:var(--danger);">${unspecified}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;color:var(--danger);">Not Specified — AMI field blank</td>
      </tr>` : '') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;font-weight:700;">Total persons served</td>
    </tr>`;
}

function renderR2Preview(unique) {
  const counts      = countByField(unique, 'reCode', RE_CODES);
  const unspecified = unique.filter(r => !RE_CODES.includes(r.reCode)).length;
  const total       = unique.length;
  const femaleCt    = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('r2PreviewBody').innerHTML =
    RE_CODES.map(code => {
      const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
      return `<tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${counts[code] || 0}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-size:0.8rem;">${RE_CODE_LABELS[code] || code}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${hispCt}</td>
      </tr>`;
    }).join('') +
    (unspecified > 0 ? `
      <tr>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;color:var(--danger);">${unspecified}</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;color:var(--danger);">Not Specified — Race/Ethnicity blank</td>
        <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;"></td>
      </tr>` : '') + `
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
  const counts1      = countCdbgAmi(unique);
  const unspecified1 = unique.filter(r => !CDBG_AMI_LEVELS.includes(amiCdbgCategory(r.amiPercent))).length;
  document.getElementById('r1PrintBody').innerHTML =
    CDBG_AMI_LEVELS.map(level => `
      <tr>
        <td class="num">${counts1[level] || 0}</td>
        <td>${amiLabel(level)}</td>
      </tr>`).join('') +
    (unspecified1 > 0 ? `<tr><td class="num">${unspecified1}</td><td>Not Specified</td></tr>` : '') + `
    <tr style="font-weight:700;">
      <td class="num">${unique.length}</td>
      <td>Total persons served</td>
    </tr>`;

  // Report 2 print table
  const counts2      = countByField(unique, 'reCode', RE_CODES);
  const unspecified2 = unique.filter(r => !RE_CODES.includes(r.reCode)).length;
  const femaleCt     = unique.filter(r => r.femaleHeaded).length;
  document.getElementById('r2PrintBody').innerHTML =
    RE_CODES.map(code => {
      const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
      return `<tr>
        <td class="num">${counts2[code] || 0}</td>
        <td>${RE_CODE_LABELS[code] || code}</td>
        <td class="num">${hispCt}</td>
      </tr>`;
    }).join('') +
    (unspecified2 > 0 ? `<tr><td class="num">${unspecified2}</td><td>Not Specified</td><td></td></tr>` : '') + `
    <tr style="font-weight:700;">
      <td class="num">${unique.length}</td><td>Total Households served</td><td></td>
    </tr>
    <tr style="font-weight:700;">
      <td class="num">${femaleCt}</td><td colspan="2">Number of Female-Headed Households</td>
    </tr>`;
}

// ── Client detail table ───────────────────────────────────────────────────────

function renderClientDetail(allRows, unique) {
  const el = document.getElementById('clientDetailBody');
  if (!el) return;

  const uniqueIds = new Set(unique.map(r => r._clientId || (r.caseNo || '').trim() || (r.clientName || '').toLowerCase().trim()));

  // Group all sessions by client key
  const byClient = {};
  allRows.forEach(r => {
    const key = r._clientId || (r.caseNo || '').trim() || (r.clientName || '').toLowerCase().trim();
    if (!key) return;
    if (!byClient[key]) byClient[key] = { r, sessions: [] };
    const d = toDate(r.counselingDate);
    byClient[key].sessions.push(d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
  });

  const rows = Object.values(byClient).sort((a, b) =>
    (a.r.clientName || '').localeCompare(b.r.clientName || '')
  );

  if (!rows.length) { el.textContent = 'No clients.'; return; }

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:0.8125rem;">
      <thead>
        <tr style="background:#f8f9fb;">
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;text-align:right;width:32px;">#</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Client Name</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Counselor</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Session Date(s)</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Source</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">AMI</th>
          <th style="border:1px solid var(--border);padding:0.3rem 0.5rem;">Type</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((entry, i) => {
          const r = entry.r;
          const src = r._clientId ? 'Sessions' : 'Legacy Log';
          const srcColor = r._clientId ? 'var(--primary)' : '#b45309';
          return `<tr>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:right;color:var(--text-muted);">${i + 1}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-weight:600;">${esc(r.clientName || '—')}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;">${esc(r.counselor || '—')}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.775rem;">${entry.sessions.join(', ')}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.75rem;font-weight:700;color:${srcColor};">${src}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.775rem;">${esc(String(r.amiPercent || '—'))}</td>
            <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.775rem;">${esc(r.counselingType || '—')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
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
