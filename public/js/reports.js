import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { MONTHS, AMI_LEVELS, RE_CODES, RE_CODE_LABELS } from './data.js';
import {
  collection, collectionGroup, getDocs, query, where, orderBy
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// window.docx is loaded via the <script src="…/docx/build/index.js"> tag in reports.html
const {
  Document, Paragraph, Table, TableRow, TableCell, TextRun,
  WidthType, AlignmentType, BorderStyle, Packer
} = window.docx;

let reportData = null; // { unique, rows } for selected month

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
  document.getElementById('reportYear').value = new Date().getFullYear();

  // Set default person completing form
  document.getElementById('r1Person').value = profile.name || '';
  document.getElementById('r2Person').value = profile.name || '';

  // Load on month/year change
  monthSel.addEventListener('change', loadMonth);
  document.getElementById('reportYear').addEventListener('change', loadMonth);

  await loadMonth();

  document.getElementById('downloadR1').addEventListener('click', () => generateReport1());
  document.getElementById('downloadR2').addEventListener('click', () => generateReport2());

  // Court report
  document.getElementById('courtReportYear').value = new Date().getFullYear();
  document.getElementById('loadCourtReportBtn').addEventListener('click', loadCourtReport);
});

async function loadMonth() {
  const month = document.getElementById('reportMonth').value;
  const year  = document.getElementById('reportYear').value;
  if (!month || !year) return;

  const dateLabel = `${new Date().toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'})} (for month of ${month} ${year})`;
  document.getElementById('r1Date').value = dateLabel;
  document.getElementById('r2Date').value = dateLabel;

  document.getElementById('reportStatus').textContent = 'Loading data…';
  document.getElementById('downloadR1').disabled = true;
  document.getElementById('downloadR2').disabled = true;

  const snap = await getDocs(query(collection(db, 'counselingLog')));
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  rows = rows.filter(r => r.sourceMonth === month);

  // Unique households
  const seen = new Set();
  const unique = rows.filter(r => {
    const key = (r.caseNo || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  reportData = { unique, rows };

  document.getElementById('reportStatus').textContent =
    `${unique.length} unique households / ${rows.length} sessions for ${month} ${year}.`;

  renderR1Preview(unique);
  renderR2Preview(unique);

  document.getElementById('downloadR1').disabled = false;
  document.getElementById('downloadR2').disabled = false;
  document.getElementById('r1Preview').style.display = 'block';
  document.getElementById('r2Preview').style.display = 'block';
}

// ── Report 1: Income ─────────────────────────────────────────────────────────

function renderR1Preview(unique) {
  const counts = countByField(unique, 'amiPercent', AMI_LEVELS);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const tbody = document.getElementById('r1PreviewBody');
  tbody.innerHTML = AMI_LEVELS.map(level => `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;">${counts[level] || 0}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;">${amiReportLabel(level)}</td>
    </tr>`).join('') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;font-weight:700;">Total persons served</td>
    </tr>`;
}

function amiReportLabel(level) {
  const map = {
    'Extremely Low':    'Extremely Low (or Very Low)',
    'Low':              'Low',
    'Moderate':         'Moderate (or Low-Moderate)',
    'Non Low-Moderate': 'Non Low-Moderate'
  };
  return map[level] || level;
}

async function generateReport1() {
  const { unique } = reportData;
  const counts = countByField(unique, 'amiPercent', AMI_LEVELS);
  const total  = Object.values(counts).reduce((s, n) => s + n, 0);

  const projectName = document.getElementById('r1ProjectName').value;
  const projectNum  = document.getElementById('r1ProjectNumber').value;
  const dateStr     = document.getElementById('r1Date').value;
  const person      = document.getElementById('r1Person').value;

  const headerRows = [
    ['Project Name:',   projectName],
    ['Project Number:', projectNum],
    ['Date:',           dateStr],
    ['Completed By:',   person],
  ];

  const tableRows = [
    ...AMI_LEVELS.map(level => [String(counts[level] || 0), amiReportLabel(level)]),
    [String(total), 'Total persons served'],
  ];

  const doc = new Document({
    sections: [{
      children: [
        boldParagraph('CDBG Direct Benefit Report Form — Income (Owner Households)'),
        ...headerRows.map(([label, value]) => labelValueParagraph(label, value)),
        new Paragraph({ text: '' }),
        buildTable2Col(['Count', 'AMI Category'], tableRows),
      ]
    }]
  });

  await downloadDocx(doc, `CDBG_Income_Report_${document.getElementById('reportMonth').value}.docx`);
}

// ── Report 2: Race & Ethnicity ────────────────────────────────────────────────

function renderR2Preview(unique) {
  const reCounts = countByField(unique, 'reCode', RE_CODES);
  const total = Object.values(reCounts).reduce((s, n) => s + n, 0);
  const femaleCt = unique.filter(r => r.femaleHeaded).length;

  const tbody = document.getElementById('r2PreviewBody');
  tbody.innerHTML = RE_CODES.map(code => {
    const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
    return `<tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${reCounts[code] || 0}</td>
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

async function generateReport2() {
  const { unique } = reportData;
  const reCounts = countByField(unique, 'reCode', RE_CODES);
  const total    = Object.values(reCounts).reduce((s, n) => s + n, 0);
  const femaleCt = unique.filter(r => r.femaleHeaded).length;

  const projectName = document.getElementById('r2ProjectName').value;
  const projectNum  = document.getElementById('r2ProjectNumber').value;
  const dateStr     = document.getElementById('r2Date').value;
  const person      = document.getElementById('r2Person').value;

  const headerRows = [
    ['Project Name:',   projectName],
    ['Project Number:', projectNum],
    ['Date:',           dateStr],
    ['Completed By:',   person],
  ];

  const tableRows = RE_CODES.map(code => {
    const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
    return [String(reCounts[code] || 0), RE_CODE_LABELS[code] || code, String(hispCt)];
  });
  tableRows.push([String(total), 'Total Households served', '']);
  tableRows.push([String(femaleCt), 'Number of Female-Headed Households', '']);

  const doc = new Document({
    sections: [{
      children: [
        boldParagraph('CDBG Direct Benefit Reporting Form — Race & Ethnicity Owner Households'),
        ...headerRows.map(([label, value]) => labelValueParagraph(label, value)),
        new Paragraph({ text: '' }),
        buildTable3Col(['Count', 'Race / Ethnicity', 'Hispanic Count'], tableRows),
      ]
    }]
  });

  await downloadDocx(doc, `CDBG_RaceEthnicity_Report_${document.getElementById('reportMonth').value}.docx`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countByField(rows, field, orderedKeys) {
  const counts = {};
  orderedKeys.forEach(k => { counts[k] = 0; });
  rows.forEach(r => {
    const k = r[field];
    if (k in counts) counts[k]++;
  });
  return counts;
}

function boldParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 28 })],
    spacing: { after: 200 }
  });
}

function labelValueParagraph(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: label + ' ', bold: true }),
      new TextRun({ text: value }),
    ],
    spacing: { after: 80 }
  });
}

function cellBorder() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  return { top: b, bottom: b, left: b, right: b };
}

function makeCell(text, bold = false, width) {
  const opts = {
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), bold })],
      alignment: AlignmentType.LEFT,
    })],
    borders: cellBorder(),
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  };
  if (width) opts.width = { size: width, type: WidthType.DXA };
  return new TableCell(opts);
}

function buildTable2Col(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map(h => makeCell(h, true)), tableHeader: true }),
      ...rows.map(([c1, c2]) => new TableRow({ children: [makeCell(c1), makeCell(c2)] })),
    ]
  });
}

function buildTable3Col(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map(h => makeCell(h, true)), tableHeader: true }),
      ...rows.map(([c1, c2, c3]) => new TableRow({ children: [makeCell(c1), makeCell(c2), makeCell(c3)] })),
    ]
  });
}

// ── Court Appearance Report ───────────────────────────────────────────────────
//
// Uses collectionGroup('sessions') to query across ALL clients' session
// subcollections in one request, filtered by date range for the selected year.
// Results are filtered client-side for caseStatus starting with "Court".
//
// Sessions written by court-appearance.js store clientName directly on the
// session doc so this query can display names without needing to load each
// client doc separately.
//
// NOTE: This query requires a Firestore index on sessions.date. If you see a
// "Missing index" error in the browser console, Firebase provides a one-click
// link to create it.

async function loadCourtReport() {
  const year    = parseInt(document.getElementById('courtReportYear').value, 10);
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

    // Filter to court sessions only and extract clientId from the path
    const sessions = snap.docs
      .map(d => ({
        id:         d.id,
        clientId:   d.ref.parent.parent.id,
        ...d.data(),
      }))
      .filter(s => (s.caseStatus || '').startsWith('Court'));

    if (!sessions.length) {
      resultEl.innerHTML = `<span style="color:var(--text-muted);">No court appearances logged in ${year}.</span>`;
      return;
    }

    // Group by date + county key (e.g. "2025-03-15|Beaver County")
    const groups = {};
    for (const s of sessions) {
      const dateMs  = s.date?.toDate ? s.date.toDate() : new Date(s.date);
      const dateStr = dateMs.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      // caseStatus = "Court — Beaver County"
      const county  = (s.caseStatus || '').replace(/^Court\s*[—-]\s*/i, '').trim() || 'Unknown County';
      const key     = `${dateMs.toISOString().split('T')[0]}|${county}`;

      if (!groups[key]) {
        groups[key] = {
          dateStr,
          dateMs,
          county,
          counselors: new Set(),
          clients: [],
        };
      }
      const g = groups[key];
      if (s.counselor) g.counselors.add(s.counselor);
      const name = (s.clientName || '').trim();
      if (name && !g.clients.includes(name)) g.clients.push(name);
    }

    // Sort by date descending
    const sorted = Object.values(groups).sort((a, b) => b.dateMs - a.dateMs);

    // Totals
    const totalDates   = sorted.length;
    const totalClients = sorted.reduce((s, g) => s + g.clients.length, 0);

    resultEl.innerHTML = `
      <div style="margin-bottom:0.75rem;font-size:0.8125rem;color:var(--text-muted);">
        <strong style="color:var(--text);">${totalDates}</strong> court date${totalDates !== 1 ? 's' : ''} &nbsp;·&nbsp;
        <strong style="color:var(--text);">${totalClients}</strong> total client appearances in ${year}
      </div>
      <div class="table-wrapper">
        <table style="font-size:0.875rem;">
          <thead>
            <tr>
              <th>Court Date</th>
              <th>County</th>
              <th style="text-align:right;"># Clients</th>
              <th>Counselor(s)</th>
              <th>Clients</th>
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
                  g.clients.length
                    ? g.clients.map(n => esc(toTitleCase(n))).join(', ')
                    : '—'
                }</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--danger);">Failed to load: ${esc(err.message)}</span>`;
  } finally {
    document.getElementById('loadCourtReportBtn').disabled = false;
  }
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

async function downloadDocx(docObj, filename) {
  const blob = await Packer.toBlob(docObj);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
